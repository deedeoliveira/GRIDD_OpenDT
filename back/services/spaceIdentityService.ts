import spaceDb, { SpaceCanonicalSchemaError } from "../utils/spaceDatabase.ts";
import { getSpaceIdentityResolver } from "../identity/spaceIdentityProvider.ts";
import { groupDuplicateInventoryCodes, groupDuplicateGlobalIds } from "./spatialPreflightService.ts";
import { isValidIfcGlobalId, ifcGlobalIdInvalidReason } from "../utils/ifcGlobalId.ts";
import { classifyDuplicateKey } from "../utils/mysqlDuplicateKey.ts";
import type { SpaceIdentityResult } from "../identity/types.ts";
import type { ExtractedIfcModel, SpaceOccurrence } from "../requirements/modelRequirementsTypes.ts";

/**
 * Serviço de domínio da identidade espacial (perfil IFC4x3, ADR-0052).
 *
 * A AUTORIDADE de identidade persistente do IfcSpace é `linked_model_id +
 * IfcSpace.GlobalId` (exata, case-sensitive). Regras:
 *  - mesmo GlobalId (mesmo linked_model)        → mesmo spaces.id/space_uuid;
 *  - mesmo GlobalId + código diferente          → mesmo espaço; o código de
 *    inventário corrente (de IfcSpace.Name) e o long_name (de IfcSpace.LongName)
 *    são atualizados, snapshots históricos não;
 *  - GlobalId diferente + mesmo código          → espaço DIFERENTE; a unicidade
 *    institucional do código (uq_spaces_scope_code) bloqueia com um erro preciso
 *    de colisão de código de inventário (nunca reaproveita por código/Name);
 *  - GlobalId novo                              → espaço novo (recebe ifc_global_id);
 *  - o mesmo GlobalId em linked_models diferentes → espaços distintos.
 *
 * O código de inventário institucional vem de IfcSpace.Name e é obrigatório; o
 * long_name vem de IfcSpace.LongName (opcional). A propriedade de Reference
 * (deprecada, ADR-0052 §E) NUNCA é lida nem interpretada. Não há inferência de linhagem.
 */

export class DuplicateSpaceInventoryCodeError extends Error {
    readonly diagnostics: any[];
    constructor(message: string, diagnostics: any[]) {
        super(message);
        this.name = "DuplicateSpaceInventoryCodeError";
        this.diagnostics = diagnostics;
    }
}

/**
 * Blocking: a candidate IfcSpace has a missing or malformed GlobalId. Carries a
 * stable machine code (§7) and never triggers a Name/Reference fallback. The full
 * form ^[0-9A-Za-z_$]{22}$ is validated at the application boundary BEFORE any
 * write; the DB CHECK remains the final defence in depth.
 */
export class InvalidSpaceGlobalIdError extends Error {
    readonly code = "invalid_globalid" as const;
    readonly diagnostics: any[];
    constructor(message: string, diagnostics: any[]) {
        super(message);
        this.name = "InvalidSpaceGlobalIdError";
        this.diagnostics = diagnostics;
    }
}

/** Blocking: two or more candidate IfcSpaces share an EXACT GlobalId in one version. */
export class DuplicateSpaceGlobalIdError extends Error {
    readonly code = "duplicate_candidate_globalid" as const;
    readonly diagnostics: any[];
    constructor(message: string, diagnostics: any[]) {
        super(message);
        this.name = "DuplicateSpaceGlobalIdError";
        this.diagnostics = diagnostics;
    }
}

/**
 * Blocking (ADR-0052): a NEW GlobalId cannot reuse a persistent space whose
 * institutional inventory code (from IfcSpace.Name) it happens to reuse, because the
 * scope inventory-code uniqueness index uq_spaces_scope_code enforces one code per
 * linked_model. GlobalId indicates a distinct persistent space; nothing is created or
 * reassigned. Never resolved silently by inventory code / Name.
 */
export class InventoryCodeCollisionError extends Error {
    readonly code = "inventory_code_collision" as const;
    readonly diagnostics: any;
    constructor(message: string, diagnostics: any) {
        super(message);
        this.name = "InventoryCodeCollisionError";
        this.diagnostics = diagnostics;
    }
}

/**
 * Blocking (ADR-0052): the extraction did not provide the ordered, lossless per-IfcSpace
 * occurrence list. Because the GlobalId-keyed inventory has already collapsed duplicate
 * GlobalIds, write-authoritative intake CANNOT prove GlobalId uniqueness without it — so
 * it refuses to persist rather than silently trusting the collapsed dict.
 */
export class LosslessSpaceOccurrencesMissingError extends Error {
    readonly code = "lossless_space_occurrences_missing" as const;
    readonly statusCode = 422;
    readonly failureReason = "lossless per-IfcSpace occurrences missing from extraction";
    constructor(message: string) {
        super(message);
        this.name = "LosslessSpaceOccurrencesMissingError";
    }
}

/**
 * Blocking (ADR-0052): the lossless occurrence list is present but does NOT exactly
 * reconcile with the extracted inventory/candidate GlobalId set, or its per-occurrence
 * entity identifiers are missing/duplicated. Any of these means the extractor's two views
 * disagree and GlobalId uniqueness/occurrence identity cannot be trusted — so no
 * entity/space/binding write may occur.
 */
export class LosslessSpaceOccurrencesInconsistentError extends Error {
    readonly code = "lossless_space_occurrences_inconsistent" as const;
    readonly statusCode = 422;
    readonly failureReason = "lossless per-IfcSpace occurrences inconsistent with the extracted inventory";
    readonly diagnostics: any;
    constructor(message: string, diagnostics: any) {
        super(message);
        this.name = "LosslessSpaceOccurrencesInconsistentError";
        this.diagnostics = diagnostics;
    }
}

export interface SpaceCandidateInput {
    guid: string;
    name?: string | null;
    longName?: string | null;
    psets?: Record<string, Record<string, unknown>> | null;
    entityId: number;
}

/**
 * SHARED, PURE validator of the lossless occurrence contract (ADR-0052). Used by BOTH
 * the orchestration preflight and `persistSpaceIdentities`, so the definition of "the
 * lossless contract" can never diverge. It performs NO database access and NO writes.
 * Order (each blocking): presence, non-empty, invalid GlobalId, duplicate exact GlobalId,
 * exact set match with the candidate/inventory GlobalId set, entity-id integrity.
 * Returns the validated occurrences.
 */
export function validateLosslessOccurrenceContract(input: {
    occurrences: unknown;
    /** GlobalId-unique candidate/inventory set (spaces that will be persisted). */
    expectedGuids: string[];
    modelVersionId: number;
    linkedModelId: number | null;
}): SpaceOccurrence[] {
    if (!Array.isArray(input.occurrences)) {
        logSpaceIdentity("lossless_occurrences_missing", { modelVersionId: input.modelVersionId, linkedModelId: input.linkedModelId });
        throw new LosslessSpaceOccurrencesMissingError(
            "The extraction did not provide the lossless per-IfcSpace occurrence list; refusing to persist because duplicate IfcSpace GlobalId uniqueness cannot be proven from the GlobalId-collapsed inventory. Re-extract with a bridge that emits spaceOccurrences.",
        );
    }
    const rawList = input.occurrences as unknown[];
    const expected = new Set(input.expectedGuids);

    // 2. empty occurrences while the inventory/candidate set has spaces.
    if (rawList.length === 0 && expected.size > 0) {
        throw new LosslessSpaceOccurrencesInconsistentError(
            `The lossless occurrence list is empty but ${expected.size} IfcSpace candidate(s) were extracted; the extractor's two views disagree.`,
            { missing: [...expected], extra: [], reason: "empty_occurrences" },
        );
    }

    // 2.5 RUNTIME SHAPE validation of EVERY element. `occurrences` is intentionally
    // `unknown`, so each element's STRUCTURE is validated BEFORE any of its properties are
    // dereferenced: a malformed element yields a stable
    // `lossless_space_occurrences_inconsistent` reason, never a TypeError.
    const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
    const isOptString = (v: unknown): boolean => v === undefined || v === null || typeof v === "string";
    for (let i = 0; i < rawList.length; i++) {
        const el = rawList[i];
        if (!isPlainObject(el)) {
            throw new LosslessSpaceOccurrencesInconsistentError(
                `Lossless occurrence at index ${i} is not an object; the extractor's occurrence records are malformed.`,
                { reason: "malformed_occurrence", index: i },
            );
        }
        if (el.entityId === null || el.entityId === undefined) {
            throw new LosslessSpaceOccurrencesInconsistentError(
                `Lossless occurrence at index ${i} is missing an IFC entity id, which the authoritative extractor must provide.`,
                { reason: "missing_entity_id", index: i },
            );
        }
        if (typeof el.entityId !== "number" || !Number.isSafeInteger(el.entityId) || el.entityId <= 0) {
            throw new LosslessSpaceOccurrencesInconsistentError(
                `Lossless occurrence at index ${i} has an invalid IFC entity id; a positive integer is required.`,
                { reason: "invalid_entity_id", index: i },
            );
        }
        if (!isOptString(el.name) || !isOptString(el.longName) || !isOptString((el as any).storeyName)) {
            throw new LosslessSpaceOccurrencesInconsistentError(
                `Lossless occurrence at index ${i} has a non-string name/longName/storeyName field.`,
                { reason: "malformed_occurrence", index: i },
            );
        }
        if (el.psets !== undefined && el.psets !== null && !isPlainObject(el.psets)) {
            throw new LosslessSpaceOccurrencesInconsistentError(
                `Lossless occurrence at index ${i} has a non-object property set map.`,
                { reason: "malformed_occurrence", index: i },
            );
        }
    }
    const occurrences = rawList as SpaceOccurrence[];

    // 3. invalid GlobalId.
    const invalid = occurrences.filter((o) => !isValidIfcGlobalId(o.guid));
    if (invalid.length > 0) {
        const diagnostics = invalid.map((o) => ({
            entityId: o?.entityId ?? null, guid: typeof o?.guid === "string" ? o.guid : null,
            name: o?.name ?? null, reason: ifcGlobalIdInvalidReason(o?.guid),
        }));
        logSpaceIdentity("invalid_global_id", { modelVersionId: input.modelVersionId, diagnostics, phase: "contract" });
        throw new InvalidSpaceGlobalIdError(
            `One or more IfcSpace elements have a missing or malformed GlobalId (expected ^[0-9A-Za-z_$]{22}$); identity cannot fall back to Name or Reference.`,
            diagnostics,
        );
    }

    // 4. duplicate exact GlobalId.
    const duplicates = groupDuplicateGlobalIds(occurrences);
    if (duplicates.size > 0) {
        const diagnostics = [...duplicates].map(([guid, group]) => ({
            ifcGlobalId: guid, linkedModelId: input.linkedModelId, candidateCount: group.length,
            entities: group.map((g) => ({ entityId: g.entityId ?? null, name: g.name ?? null, longName: g.longName ?? null })),
        }));
        logSpaceIdentity("duplicate_global_id", { modelVersionId: input.modelVersionId, diagnostics, phase: "contract" });
        throw new DuplicateSpaceGlobalIdError(
            `Duplicate IfcSpace GlobalId(s) in one model version: ${[...duplicates.keys()].join(", ")}`,
            diagnostics,
        );
    }

    // 5. exact occurrence↔candidate GlobalId set reconciliation (after invalid + dup).
    const occGuids = new Set(occurrences.map((o) => o.guid));
    const missing = [...expected].filter((g) => !occGuids.has(g)); // candidate not represented
    const extra = [...occGuids].filter((g) => !expected.has(g));    // occurrence not in inventory
    if (missing.length > 0 || extra.length > 0) {
        logSpaceIdentity("lossless_occurrences_inconsistent", { modelVersionId: input.modelVersionId, missing, extra });
        throw new LosslessSpaceOccurrencesInconsistentError(
            `The lossless occurrence GlobalId set does not match the extracted IfcSpace candidate set (${missing.length} omitted, ${extra.length} extra).`,
            { missing, extra, reason: "set_mismatch" },
        );
    }

    // 6. entity-id integrity: each occurrence carries a DISTINCT entity id.
    const seen = new Set<number>();
    const dupIds: number[] = [];
    for (const o of occurrences) {
        const id = Number(o.entityId);
        if (seen.has(id)) dupIds.push(id);
        seen.add(id);
    }
    if (dupIds.length > 0) {
        throw new LosslessSpaceOccurrencesInconsistentError(
            `Duplicated IFC entity id(s) across lossless occurrences: ${[...new Set(dupIds)].join(", ")}.`,
            { reason: "duplicate_entity_id", entityIds: [...new Set(dupIds)] },
        );
    }

    return occurrences;
}

/**
 * PURE candidate GlobalId preflight (ADR-0052), run immediately after extraction +
 * requirements validation and BEFORE any persistent write. It does NO database access and
 * NO writes; it only validates the CANDIDATE contract from the lossless occurrences.
 */
export function preflightSpaceOccurrences(input: {
    extracted: Pick<ExtractedIfcModel, "spaceOccurrences" | "inventoryData">;
    modelVersionId: number;
    linkedModelId: number | null;
}): { occurrences: SpaceOccurrence[] } {
    const occurrences = validateLosslessOccurrenceContract({
        occurrences: input.extracted.spaceOccurrences,
        expectedGuids: Object.keys(input.extracted.inventoryData ?? {}),
        modelVersionId: input.modelVersionId,
        linkedModelId: input.linkedModelId,
    });
    return { occurrences };
}

export interface SpaceIdentityOutcome {
    createdSpaceIds: number[];
    bindingsCreated: number;
    diagnostics: {
        ignored_missing_inventory_code: string[];   // guids (IfcSpace.Name absent/blank)
        invalid_inventory_code: { guid: string; reasons: string[] }[];
        duplicate_inventory_code: any[];
        reused_spaces: number;
        created_spaces: number;
        isAuthoritative: boolean;
        authorityModelId: number | null;
    };
    /** Códigos normalizados presentes (para reconciliação pós-ativação). */
    presentNormalizedCodes: string[];
    /** guid do IfcSpace → identidade persistente (para o inventário de ativos). */
    spaceInfoByGuid: Record<string, { spaceId: number; code: string }>;
    /**
     * Metadata changes applied to REUSED (pre-existing) spaces during this operation
     * (ADR-0052 §8). The upload compensation restores these if the operation later fails
     * — deleting orphan spaces does NOT undo an UPDATE to an existing row. Each restore is
     * a full compare-and-swap on the COMPLETE applied projection (inventory code +
     * normalized + long_name), so it never clobbers a newer concurrent successful change.
     */
    metadataUpdates: Array<{
        spaceId: number;
        appliedInventoryCode: string;
        appliedInventoryCodeNormalized: string;
        appliedLongName: string | null;
        previousInventoryCode: string | null;
        previousInventoryCodeNormalized: string | null;
        previousLongName: string | null;
    }>;
}

/** Collector for space-metadata restorations (compensation journal). */
type MetadataUpdateRecord = SpaceIdentityOutcome["metadataUpdates"][number];

function logSpaceIdentity(event: string, payload: Record<string, unknown>) {
    console.log(JSON.stringify({ type: "space_identity", event, at: new Date().toISOString(), ...payload }));
}

/**
 * TEST-ONLY barrier hook (faithful two-connection race). Invoked — when set — AFTER the
 * real inventory-code pre-check SELECT completes and BEFORE the real
 * `updateCurrentSpaceMetadata`, so a test can, on a SECOND real connection, assign the
 * inventory code to another space and let the actual UPDATE hit `uq_spaces_scope_code`.
 * It is `undefined` in production and adds NO production behaviour.
 */
let afterInventoryCodePrecheckHook: ((ctx: { linkedModelId: number; code: string; spaceId: number }) => Promise<void>) | undefined;
export function __setAfterInventoryCodePrecheckHook(
    fn: ((ctx: { linkedModelId: number; code: string; spaceId: number }) => Promise<void>) | undefined,
): void { afterInventoryCodePrecheckHook = fn; }

/**
 * Update the current mutable metadata (institutional inventory code from IfcSpace.Name +
 * long_name from IfcSpace.LongName) of an ALREADY-MATCHED persistent space when (and only
 * when) the inventory code changed, applying the inventory-code collision rule (ADR-0052
 * §8): the candidate inventory code must not belong to a DIFFERENT persistent space under
 * uq_spaces_scope_code. The space identity (linked_model + GlobalId, spaces.id,
 * space_uuid) is never altered here; another space's code is never silently overwritten.
 */
async function applySpaceMetadataUpdateIfChanged(input: {
    space: any; code: string; rawValue: string; longName: string | null;
    linkedModelId: number; guid: string; modelVersionId: number;
    record: MetadataUpdateRecord[];
}): Promise<void> {
    // The COMPLETE mutable current projection is inventory_code (raw IfcSpace.Name),
    // inventory_code_normalized, AND long_name (IfcSpace.LongName). Compare all three by
    // exact string/null equality — a LongName-only change (including string→null and
    // null→string) is a real projection change and MUST be applied and journalled, even
    // though the normalized inventory code is unchanged (ADR-0052 §C/§D/§8).
    const previousInventoryCode = input.space.inventory_code ?? null;
    const previousInventoryCodeNormalized = input.space.inventory_code_normalized ?? null;
    const previousLongName = input.space.long_name ?? null;

    const inventoryCodeChanged = previousInventoryCode !== input.rawValue;
    const normalizedInventoryCodeChanged = previousInventoryCodeNormalized !== input.code;
    const longNameChanged = previousLongName !== input.longName;
    const metadataChanged = inventoryCodeChanged || normalizedInventoryCodeChanged || longNameChanged;

    // Return early ONLY when every current field already equals the incoming projection
    // (including null-to-null long_name) — never merely because the normalized code matched.
    if (!metadataChanged) return;

    // The inventory-code ownership/collision pre-check is relevant ONLY when the NORMALIZED
    // code actually changes. A LongName-only (or raw-only, same-normalized) change reuses the
    // SAME persistent identity and must not run an ownership conflict or be treated as a new
    // inventory code. Identity stays linked_model_id + exact GlobalId; no lookup by LongName
    // or by inventory code drives identity.
    if (normalizedInventoryCodeChanged) {
        const clash = await spaceDb.findByScopeAndCode(input.linkedModelId, input.code);
        if (clash && Number(clash.id) !== Number(input.space.id)) {
            throw new InventoryCodeCollisionError(
                `IfcSpace ${input.guid} keeps its persistent identity but its new inventory code '${input.code}' (from IfcSpace.Name) is already assigned to a different persistent space (id ${clash.id}) under the scope uniqueness constraint uq_spaces_scope_code. No row was created or reassigned.`,
                { ifcGlobalId: input.guid, spaceId: input.space.id, newInventoryCode: input.code, conflictingSpaceId: clash.id, linkedModelId: input.linkedModelId },
            );
        }
        // faithful-race barrier: the real pre-check above observed the code as free; a test
        // may now (on a second connection) claim it before our real UPDATE runs.
        if (afterInventoryCodePrecheckHook) {
            await afterInventoryCodePrecheckHook({ linkedModelId: input.linkedModelId, code: input.code, spaceId: Number(input.space.id) });
        }
    }
    try {
        await spaceDb.updateCurrentSpaceMetadata({
            spaceId: input.space.id, inventoryCode: input.rawValue, inventoryCodeNormalized: input.code, longName: input.longName,
        });
    } catch (error: any) {
        // CHECK-THEN-UPDATE race: another operation claimed the code between the pre-check
        // and the UPDATE. The unique index is the final authority — translate its duplicate
        // deterministically, never leak the raw ER_DUP_ENTRY, and never partially update.
        const kind = classifyDuplicateKey(error);
        if (kind === "scope_inventory_code") {
            throw new InventoryCodeCollisionError(
                `IfcSpace ${input.guid} kept its persistent identity but its new inventory code '${input.code}' was concurrently claimed by another persistent space under the scope uniqueness constraint uq_spaces_scope_code. No field was updated.`,
                { ifcGlobalId: input.guid, spaceId: input.space.id, newInventoryCode: input.code, linkedModelId: input.linkedModelId, concurrent: true },
            );
        }
        throw error; // unrelated duplicate/other error — never misclassified
    }
    // Record for compensation (§8): the prior values, and the COMPLETE projection we
    // applied (inventory code + normalized + long_name) so the restore is a full
    // compare-and-swap that never clobbers a newer change — including a LongName-only change.
    input.record.push({
        spaceId: Number(input.space.id),
        appliedInventoryCode: input.rawValue,
        appliedInventoryCodeNormalized: input.code,
        appliedLongName: input.longName,
        previousInventoryCode,
        previousInventoryCodeNormalized,
        previousLongName,
    });
    logSpaceIdentity("space_metadata_changed", {
        modelVersionId: input.modelVersionId, spaceId: input.space.id, ifcGlobalId: input.guid,
        inventoryCodeChanged, normalizedInventoryCodeChanged, longNameChanged,
        previousInventoryCode, newInventoryCode: input.rawValue,
        previousInventoryCodeNormalized, newInventoryCodeNormalized: input.code,
        previousLongName, newLongName: input.longName,
    });
}

/**
 * After a real canonical-index unique conflict, re-resolve the concurrently created row
 * and VERIFY it before reuse (§8): same linked_model_id, byte-equal GlobalId, non-null
 * spaces.id and space_uuid. The metadata of the raced row is treated as mutable: if the
 * inventory code differs from the current candidate it is updated under the SAME
 * inventory-code collision rules — never silently overwriting another space's code.
 */
async function resolveRacedCanonicalIdentity(input: {
    linkedModelId: number; guid: string; code: string; rawValue: string; longName: string | null;
    modelVersionId: number; originalError: any; record: MetadataUpdateRecord[];
}): Promise<{ id: number }> {
    const raced = await spaceDb.findByScopeAndGlobalId(input.linkedModelId, input.guid);
    if (!raced) throw input.originalError; // the conflict was not actually our identity
    if (Number(raced.linked_model_id) !== Number(input.linkedModelId)
        || raced.ifc_global_id !== input.guid
        || raced.id == null || raced.space_uuid == null) {
        throw new Error(
            `Concurrent canonical re-resolution returned an inconsistent row for GlobalId ${input.guid} (linked_model ${input.linkedModelId}); refusing to reuse it.`,
        );
    }
    logSpaceIdentity("concurrent_identity_reused", {
        modelVersionId: input.modelVersionId, spaceId: raced.id, ifcGlobalId: input.guid,
    });
    await applySpaceMetadataUpdateIfChanged({
        space: raced, code: input.code, rawValue: input.rawValue, longName: input.longName,
        linkedModelId: input.linkedModelId, guid: input.guid, modelVersionId: input.modelVersionId,
        record: input.record,
    });
    return { id: raced.id };
}

/**
 * Resolve e persiste as identidades espaciais de uma versão em processamento.
 * Chamado pelo modelUploadService ANTES da ativação; em falha, a compensação
 * do upload remove bindings e espaços criados exclusivamente pela operação.
 */
export async function persistSpaceIdentities(input: {
    linkedModelId: number;
    modelId: number;
    modelVersionId: number;
    candidates: SpaceCandidateInput[];
    /** Lossless per-IfcSpace occurrences (ADR-0052) — MANDATORY. */
    occurrences: unknown;
}): Promise<SpaceIdentityOutcome> {

    // MANDATORY lossless occurrence contract — validated FIRST, before ANY schema/database
    // access. Defence in depth: the orchestration preflight already ran the same validator.
    validateLosslessOccurrenceContract({
        occurrences: input.occurrences,
        expectedGuids: input.candidates.map((c) => c.guid),
        modelVersionId: input.modelVersionId,
        linkedModelId: input.linkedModelId,
    });

    const resolver = getSpaceIdentityResolver();

    // Schema precondition + scope canonical integrity (ADR-0052 §B). A precise
    // operational/configuration error is raised here; the runtime never recreates schema,
    // runs a migration, or falls back to Name/Reference.
    await spaceDb.assertCanonicalSpaceSchema();
    const inconsistencies = await spaceDb.findScopeCanonicalInconsistencies(input.linkedModelId);
    if (inconsistencies.nullCanonical.length > 0) {
        throw new SpaceCanonicalSchemaError(
            "canonical_inconsistency",
            `Existing spaces have a NULL canonical ifc_global_id (ids: ${inconsistencies.nullCanonical.join(", ")}). Canonical backfill is incomplete; refusing to proceed without repair.`,
            { nullCanonical: inconsistencies.nullCanonical },
        );
    }
    if (inconsistencies.bindingMismatch.length > 0) {
        throw new SpaceCanonicalSchemaError(
            "canonical_inconsistency",
            `Existing space bindings disagree with their space's canonical ifc_global_id (binding ids: ${inconsistencies.bindingMismatch.map((b: any) => b.binding_id).join(", ")}). Refusing to proceed; no silent repair.`,
            { bindingMismatch: inconsistencies.bindingMismatch },
        );
    }

    const authorityModelId = await spaceDb.resolveSpatialAuthority(input.linkedModelId);
    const isAuthoritative = authorityModelId !== null && authorityModelId === input.modelId;

    const outcome: SpaceIdentityOutcome = {
        createdSpaceIds: [],
        bindingsCreated: 0,
        diagnostics: {
            ignored_missing_inventory_code: [],
            invalid_inventory_code: [],
            duplicate_inventory_code: [],
            reused_spaces: 0,
            created_spaces: 0,
            isAuthoritative,
            authorityModelId,
        },
        presentNormalizedCodes: [],
        spaceInfoByGuid: {},
        metadataUpdates: [],
    };

    /* -------- 1. resolver todos os candidatos primeiro -------- */
    const resolved: { candidate: SpaceCandidateInput; result: SpaceIdentityResult }[] = [];

    for (const candidate of input.candidates) {
        const result = await resolver.resolve(candidate, {
            linkedModelId: input.linkedModelId,
            modelId: input.modelId,
            modelVersionId: input.modelVersionId,
        });
        resolved.push({ candidate, result });
    }

    /* -------- 2. duplicações: verificação DEFENSIVA (a deteção primária,
                    para o modelo autoritativo, corre no spatial_preflight
                    antes de qualquer persistência; a lógica de agrupamento
                    é a MESMA — groupDuplicateInventoryCodes) -------- */
    const duplicates = groupDuplicateInventoryCodes(resolved);

    for (const [code, entries] of duplicates) {
        for (const entry of entries) entry.result.status = "duplicate";
        outcome.diagnostics.duplicate_inventory_code.push({
            code,
            modelVersionId: input.modelVersionId,
            modelId: input.modelId,
            linkedModelId: input.linkedModelId,
            entities: entries.map((e) => ({
                entityId: e.candidate.entityId,
                guid: e.candidate.guid,
                name: e.candidate.name ?? null,
            })),
        });
    }

    if (outcome.diagnostics.duplicate_inventory_code.length > 0) {
        logSpaceIdentity("duplicate_inventory_code", {
            modelVersionId: input.modelVersionId,
            duplicates: outcome.diagnostics.duplicate_inventory_code,
            isAuthoritative,
        });

        // Duplicação ambígua numa versão do modelo espacial autoritativo
        // impede a ativação (a falha aciona a compensação do upload).
        if (isAuthoritative) {
            const codes = outcome.diagnostics.duplicate_inventory_code.map((d: any) => d.code).join(", ");
            throw new DuplicateSpaceInventoryCodeError(
                `Duplicate space inventory code(s) in authoritative spatial model: ${codes}`,
                outcome.diagnostics.duplicate_inventory_code
            );
        }
    }

    /* -------- 3. persistir identidades e bindings -------- */
    try {
    for (const { candidate, result } of resolved) {
        if (result.status === "missing") {
            outcome.diagnostics.ignored_missing_inventory_code.push(candidate.guid);
            continue;
        }
        if (result.status === "invalid") {
            outcome.diagnostics.invalid_inventory_code.push({ guid: candidate.guid, reasons: result.reasons });
            continue;
        }
        if (result.status === "duplicate") {
            // não autoritativo: não escolher silenciosamente — sem binding
            continue;
        }

        const code = result.normalizedValue!;
        // long_name comes from IfcSpace.LongName (ADR-0052 §D); the inventory code comes
        // from IfcSpace.Name (result.rawValue) — never conflated.
        const longName = candidate.longName ?? null;

        // ---- Canonical identity lookup: linked_model_id + GlobalId ----
        let space = await spaceDb.findByScopeAndGlobalId(input.linkedModelId, candidate.guid);

        if (space) {
            // Same persistent space (same GlobalId). Preserve id/space_uuid/history.
            // If the current inventory code changed, update ONLY the current projection
            // (§8) with an inventory-code collision guard — never treat it as a new space,
            // never overwrite another space's code.
            await applySpaceMetadataUpdateIfChanged({
                space, code, rawValue: result.rawValue!, longName,
                linkedModelId: input.linkedModelId, guid: candidate.guid, modelVersionId: input.modelVersionId,
                record: outcome.metadataUpdates,
            });
            outcome.diagnostics.reused_spaces++;
        } else {
            // New GlobalId → new persistent space. Inventory-code collision (§8): a
            // DIFFERENT GlobalId must never reuse a persistent space just because its
            // inventory code matches. Detect deterministically BEFORE the insert.
            const clash = await spaceDb.findByScopeAndCode(input.linkedModelId, code);
            if (clash) {
                throw new InventoryCodeCollisionError(
                    `IfcSpace GlobalId ${candidate.guid} indicates a NEW persistent space, but its inventory code '${code}' (from IfcSpace.Name) is already assigned to persistent space id ${clash.id} (a different GlobalId), which the scope uniqueness constraint uq_spaces_scope_code forbids. No row was created or reassigned.`,
                    { ifcGlobalId: candidate.guid, newInventoryCode: code, conflictingSpaceId: clash.id, linkedModelId: input.linkedModelId },
                );
            }
            try {
                const created = await spaceDb.createSpace({
                    linkedModelId: input.linkedModelId,
                    ifcGlobalId: candidate.guid,
                    inventoryCode: result.rawValue!,
                    inventoryCodeNormalized: code,
                    longName,
                });
                space = { id: created.spaceId };
                outcome.createdSpaceIds.push(created.spaceId);
                outcome.diagnostics.created_spaces++;
            } catch (error: any) {
                // Concurrency backstop (§8) — the unique indexes are the final authority.
                // The error is classified by its STRUCTURED index name, never by prose.
                const kind = classifyDuplicateKey(error);
                if (kind === "canonical_globalid") {
                    // Another activation created the SAME canonical identity first;
                    // re-resolve and VERIFY the raced row before reusing it (§8).
                    space = await resolveRacedCanonicalIdentity({
                        linkedModelId: input.linkedModelId, guid: candidate.guid,
                        code, rawValue: result.rawValue!, longName,
                        modelVersionId: input.modelVersionId, originalError: error,
                        record: outcome.metadataUpdates,
                    });
                    outcome.diagnostics.reused_spaces++;
                } else if (kind === "scope_inventory_code") {
                    // An inventory-code-uniqueness collision surfaced concurrently.
                    throw new InventoryCodeCollisionError(
                        `IfcSpace GlobalId ${candidate.guid} could not create a new persistent space because inventory code '${code}' (from IfcSpace.Name) collided with the scope uniqueness constraint uq_spaces_scope_code. No row was created or reassigned.`,
                        { ifcGlobalId: candidate.guid, newInventoryCode: code, linkedModelId: input.linkedModelId },
                    );
                } else {
                    throw error;
                }
            }
        }

        await spaceDb.createBinding({
            spaceId: space.id,
            modelVersionId: input.modelVersionId,
            entityId: candidate.entityId,
            // Binding GlobalId is byte-identical to the canonical spaces.ifc_global_id.
            ifcGuid: candidate.guid,
            inventoryCodeSnapshot: result.rawValue!,   // from IfcSpace.Name
            longNameSnapshot: candidate.longName ?? null, // from IfcSpace.LongName
        });
        outcome.bindingsCreated++;
        outcome.presentNormalizedCodes.push(code);
        outcome.spaceInfoByGuid[candidate.guid] = { spaceId: space.id, code };
    }
    } catch (rawError: unknown) {
        // NORMALIZE the captured value to a stable Error BEFORE attaching any compensation
        // metadata. The prior metadata values remain available to compensation via
        // `metadataUpdates`.
        const error: any = rawError instanceof Error
            ? rawError
            : Object.assign(new Error(`space identity persistence failed: ${String(rawError)}`), { cause: rawError });
        // Attach the spaces already created by this operation so the upload compensation
        // can remove them safely.
        error.createdSpaceIds = outcome.createdSpaceIds;
        // Attach the metadata changes applied to REUSED spaces so the upload compensation
        // can restore them (§8) — deleting orphan spaces never undoes an UPDATE to a
        // pre-existing row.
        error.metadataUpdates = outcome.metadataUpdates;
        throw error;
    }

    if (outcome.diagnostics.ignored_missing_inventory_code.length > 0) {
        logSpaceIdentity("ignored_missing_inventory_code", {
            modelVersionId: input.modelVersionId,
            guids: outcome.diagnostics.ignored_missing_inventory_code,
        });
    }
    if (outcome.diagnostics.invalid_inventory_code.length > 0) {
        logSpaceIdentity("invalid_inventory_code", {
            modelVersionId: input.modelVersionId,
            entries: outcome.diagnostics.invalid_inventory_code,
        });
    }

    return outcome;
}

/**
 * Reconciliação de estados APÓS ativação bem-sucedida de uma versão do modelo
 * espacial AUTORITATIVO. Nunca apaga espaços; ausência marca 'absent'.
 */
export async function reconcileSpaceStatusesAfterActivation(input: {
    linkedModelId: number;
    modelId: number;
    presentNormalizedCodes: string[];
}): Promise<void> {
    const authorityModelId = await spaceDb.resolveSpatialAuthority(input.linkedModelId);

    if (authorityModelId === null || authorityModelId !== input.modelId) {
        // ausência num modelo não autoritativo NUNCA altera o estado dos espaços
        return;
    }

    try {
        await spaceDb.reconcileStatusesForLinkedModel(input.linkedModelId, input.presentNormalizedCodes);
    } catch (error: any) {
        logSpaceIdentity("reconcile_failed", {
            linkedModelId: input.linkedModelId,
            error: String(error?.message ?? error),
        });
    }
}
