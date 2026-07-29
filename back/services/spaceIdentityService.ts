import spaceDb, { SpaceCanonicalSchemaError } from "../utils/spaceDatabase.ts";
import { getSpaceIdentityResolver } from "../identity/spaceIdentityProvider.ts";
import { groupDuplicateReferences, groupDuplicateGlobalIds } from "./spatialPreflightService.ts";
import { isValidIfcGlobalId, ifcGlobalIdInvalidReason } from "../utils/ifcGlobalId.ts";
import { classifyDuplicateKey } from "../utils/mysqlDuplicateKey.ts";
import type { SpaceIdentityResult } from "../identity/types.ts";
import type { ExtractedIfcModel, SpaceOccurrence } from "../requirements/modelRequirementsTypes.ts";

/**
 * Serviço de domínio da identidade espacial.
 *
 * Stage 0B (ADR-0051): a AUTORIDADE de identidade persistente do IfcSpace é
 * `linked_model_id + IfcSpace.GlobalId` (exata, case-sensitive). Regras:
 *  - mesmo GlobalId (mesmo linked_model)        → mesmo spaces.id/space_uuid;
 *  - mesmo GlobalId + Reference diferente       → mesmo espaço; a Reference
 *    corrente (metadado administrativo) é atualizada, snapshots históricos não;
 *  - GlobalId diferente + Reference igual       → espaço DIFERENTE; durante a
 *    transição o índice legado uq_spaces_scope_code ainda existe, pelo que isto
 *    é bloqueado com um erro transitório preciso (nunca reaproveita por Reference);
 *  - GlobalId novo                              → espaço novo (recebe ifc_global_id);
 *  - o mesmo GlobalId em linked_models diferentes → espaços distintos.
 *
 * A Reference continua a ser extraída e obrigatória (esquema/IDS transitórios) e
 * é armazenada como metadado administrativo/snapshot — NUNCA como chave de
 * identidade. Não há inferência de linhagem.
 */

export class DuplicateSpaceReferenceError extends Error {
    readonly diagnostics: any[];
    constructor(message: string, diagnostics: any[]) {
        super(message);
        this.name = "DuplicateSpaceReferenceError";
        this.diagnostics = diagnostics;
    }
}

/**
 * Blocking: a candidate IfcSpace has a missing or malformed GlobalId. Carries a
 * stable machine code (§7) and never triggers a Reference fallback. The full
 * form ^[0-9A-Za-z_$]{22}$ is validated at the application boundary (§1) BEFORE
 * any write; the Stage 0A DB CHECK remains the final defence in depth.
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
 * Transitional block (ADR-0051 §3/§7): a NEW GlobalId cannot reuse a persistent
 * space whose Reference it happens to reuse, because the legacy Reference
 * uniqueness index uq_spaces_scope_code is still active. GlobalId indicates a new
 * persistent space; the conflict is only removed in a later stage; nothing was
 * created or reassigned. Never resolved silently by Reference.
 */
export class TransitionalReferenceCollisionError extends Error {
    readonly code = "transitional_reference_collision" as const;
    readonly diagnostics: any;
    constructor(message: string, diagnostics: any) {
        super(message);
        this.name = "TransitionalReferenceCollisionError";
        this.diagnostics = diagnostics;
    }
}

/**
 * Blocking (ADR-0051 Stage 0B §1): the extraction did not provide the ordered,
 * lossless per-IfcSpace occurrence list. Because the GlobalId-keyed inventory has
 * already collapsed duplicate GlobalIds, write-authoritative intake CANNOT prove
 * GlobalId uniqueness without it — so it refuses to persist rather than silently
 * trusting the collapsed dict. A stable operational code (§7) drives the failed
 * upload lifecycle; a display-only preview may still fall back (non-authoritative).
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
 * Blocking (ADR-0051 Stage 0B §1): the lossless occurrence list is present but does
 * NOT exactly reconcile with the extracted inventory/candidate GlobalId set, or its
 * per-occurrence entity identifiers are missing/duplicated. Any of these means the
 * extractor's two views disagree and GlobalId uniqueness/occurrence identity cannot
 * be trusted — so no entity/space/binding/asset/Reference write may occur.
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
 * SHARED, PURE validator of the lossless occurrence contract (ADR-0051 §1). Used by
 * BOTH the orchestration preflight and `persistSpaceIdentities`, so the definition of
 * "the lossless contract" can never diverge between them. It performs NO database
 * access and NO writes. Order (each blocking):
 *   1. presence         — occurrences must be a real array (missing/undefined/non-array
 *                         → LosslessSpaceOccurrencesMissingError);
 *   2. non-empty        — an empty list while the inventory has spaces is inconsistent;
 *   3. invalid GlobalId — any malformed occurrence GlobalId → InvalidSpaceGlobalIdError;
 *   4. duplicate exact  — two occurrences sharing one exact GlobalId → DuplicateSpaceGlobalIdError;
 *   5. exact set match  — the unique occurrence GlobalId set must equal the candidate/
 *                         inventory GlobalId set (omitted or extra → inconsistent);
 *   6. entity-id integrity — every occurrence must carry a distinct, non-null entity id
 *                         (the authoritative extractor provides one per IfcSpace entity;
 *                         missing/duplicated → inconsistent).
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

    // 2.5 RUNTIME SHAPE validation of EVERY element (ADR-0051 §5-v4). `occurrences` is
    // intentionally `unknown`, so each element's STRUCTURE is validated BEFORE any of its
    // properties are dereferenced: a malformed element yields a stable
    // `lossless_space_occurrences_inconsistent` reason, never a TypeError or raw JS
    // diagnostic. Required per element:
    //  - a non-null, non-array object;
    //  - `entityId` a POSITIVE SAFE INTEGER (never null/NaN/Infinity/0/negative/fractional/
    //    numeric-string — the authoritative extractor provides one real IFC entity id);
    //  - optional `name`/`longName`/`storeyName` are string or null/undefined;
    //  - optional `psets` is a plain object or null/undefined.
    // NOTE: `guid` itself is NOT dereferenced here — it is passed (safely, whatever its
    // runtime type) to the shared GlobalId validator in step 3, so a null/number/malformed
    // GlobalId is a blocking InvalidSpaceGlobalIdError (never a Reference fallback), exactly
    // as at every other write boundary.
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
            `One or more IfcSpace elements have a missing or malformed GlobalId (expected ^[0-9A-Za-z_$]{22}$); identity cannot fall back to Reference.`,
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

    // 6. entity-id integrity: each occurrence carries a DISTINCT entity id (presence and
    // positive-integer validity were already enforced by the runtime shape pass, §5-v4).
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
 * PURE candidate GlobalId preflight (ADR-0051 Stage 0B §2), run immediately after
 * extraction + requirements validation and BEFORE any persistent write (entities,
 * spaces, bindings, assets, Reference updates). It does NO database access and NO
 * writes; it only validates the CANDIDATE contract from the lossless occurrences:
 *  - the lossless occurrence contract is present (else the collapsed inventory
 *    cannot prove uniqueness → LosslessSpaceOccurrencesMissingError);
 *  - every IfcSpace GlobalId is well-formed (^[0-9A-Za-z_$]{22}$);
 *  - no two occurrences share the same EXACT (byte, case-sensitive) GlobalId.
 * The same checks remain INSIDE persistSpaceIdentities as defence in depth, but the
 * persistence service is no longer the first detector: a duplicate GlobalId now
 * fails before saveInventorySnapshot, so no `entities` row is ever written for it.
 */
export function preflightSpaceOccurrences(input: {
    extracted: Pick<ExtractedIfcModel, "spaceOccurrences" | "inventoryData">;
    modelVersionId: number;
    linkedModelId: number | null;
}): { occurrences: SpaceOccurrence[] } {
    // The write-authoritative preflight passes the RAW spaceOccurrences (never the
    // display-only fallback) through the SHARED contract validator, reconciled against
    // the extracted inventory GlobalId set.
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
        ignored_missing_inventory_code: string[];   // guids
        invalid_reference: { guid: string; reasons: string[] }[];
        duplicate_reference: any[];
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
     * Administrative-Reference changes applied to REUSED (pre-existing) spaces
     * during this operation (§6.B). The upload compensation restores these if the
     * operation later fails — deleting orphan spaces does NOT undo an UPDATE to an
     * existing row. Each restore is conditional on the current value still being the
     * one we applied, so it never clobbers a newer concurrent successful change.
     */
    referenceUpdates: Array<{
        spaceId: number;
        // The COMPLETE projection this operation applied (compare-and-swap token, §6):
        // the restore only reverts a row whose current projection still EXACTLY matches
        // all of these — so a newer change to the raw Reference or Name (even with the
        // same normalized Reference) is never overwritten.
        appliedInventoryCode: string;
        appliedInventoryCodeNormalized: string;
        appliedName: string | null;
        previousInventoryCode: string | null;
        previousInventoryCodeNormalized: string | null;
        previousName: string | null;
    }>;
}

/** Collector for administrative-Reference restorations (compensation journal). */
type ReferenceUpdateRecord = SpaceIdentityOutcome["referenceUpdates"][number];

function logSpaceIdentity(event: string, payload: Record<string, unknown>) {
    console.log(JSON.stringify({ type: "space_identity", event, at: new Date().toISOString(), ...payload }));
}

/**
 * TEST-ONLY barrier hook (ADR-0051 §7 faithful two-connection race). Invoked — when
 * set — AFTER the real Reference pre-check SELECT completes and BEFORE the real
 * `updateCurrentReference`, so a test can, on a SECOND real connection, assign the
 * Reference to another space and let the actual UPDATE hit `uq_spaces_scope_code`.
 * It is `undefined` in production and adds NO production behaviour.
 */
let afterReferencePrecheckHook: ((ctx: { linkedModelId: number; code: string; spaceId: number }) => Promise<void>) | undefined;
export function __setAfterReferencePrecheckHook(
    fn: ((ctx: { linkedModelId: number; code: string; spaceId: number }) => Promise<void>) | undefined,
): void { afterReferencePrecheckHook = fn; }

/**
 * Update the current administrative Reference of an ALREADY-MATCHED persistent
 * space when (and only when) it changed, applying the transitional collision
 * rules (§2 A/B/C, §6): the candidate Reference must not belong to a DIFFERENT
 * persistent space while the legacy uq_spaces_scope_code index is active. The
 * space identity (linked_model + GlobalId, spaces.id, space_uuid) is never
 * altered here; another space's Reference is never silently overwritten.
 */
async function applyReferenceUpdateIfChanged(input: {
    space: any; code: string; rawValue: string; name: string | null;
    linkedModelId: number; guid: string; modelVersionId: number;
    record: ReferenceUpdateRecord[];
}): Promise<void> {
    if (input.space.inventory_code_normalized === input.code) return; // A': unchanged
    // §2 C: deterministic pre-check — the candidate Reference must not belong to a
    // DIFFERENT persistent space.
    const clash = await spaceDb.findByScopeAndCode(input.linkedModelId, input.code);
    if (clash && Number(clash.id) !== Number(input.space.id)) {
        throw new TransitionalReferenceCollisionError(
            `IfcSpace ${input.guid} keeps its persistent identity but its new Reference '${input.code}' is still assigned to a different persistent space (id ${clash.id}) under the transitional legacy uniqueness constraint uq_spaces_scope_code. No row was created or reassigned; this constraint is removed in a later stage.`,
            { ifcGlobalId: input.guid, spaceId: input.space.id, newReference: input.code, conflictingSpaceId: clash.id, linkedModelId: input.linkedModelId },
        );
    }
    // §7 faithful-race barrier: the real pre-check above observed the Reference as free;
    // a test may now (on a second connection) claim it before our real UPDATE runs.
    if (afterReferencePrecheckHook) {
        await afterReferencePrecheckHook({ linkedModelId: input.linkedModelId, code: input.code, spaceId: Number(input.space.id) });
    }
    try {
        await spaceDb.updateCurrentReference({
            spaceId: input.space.id, inventoryCode: input.rawValue, inventoryCodeNormalized: input.code, name: input.name,
        });
    } catch (error: any) {
        // §6.A CHECK-THEN-UPDATE race: another operation claimed the Reference
        // between the pre-check and the UPDATE. The unique index is the final
        // authority — translate its duplicate deterministically, never leak the raw
        // ER_DUP_ENTRY, and never partially update.
        const kind = classifyDuplicateKey(error);
        if (kind === "legacy_reference") {
            throw new TransitionalReferenceCollisionError(
                `IfcSpace ${input.guid} kept its persistent identity but its new Reference '${input.code}' was concurrently claimed by another persistent space under the transitional legacy uniqueness constraint uq_spaces_scope_code. No field was updated.`,
                { ifcGlobalId: input.guid, spaceId: input.space.id, newReference: input.code, linkedModelId: input.linkedModelId, concurrent: true },
            );
        }
        throw error; // unrelated duplicate/other error — never misclassified
    }
    // Record for compensation (§6.B): the prior values, and the COMPLETE projection we
    // applied (raw Reference + normalized + name) so the restore is a full compare-and-
    // swap that never clobbers a newer raw-Reference/Name change.
    input.record.push({
        spaceId: Number(input.space.id),
        appliedInventoryCode: input.rawValue,
        appliedInventoryCodeNormalized: input.code,
        appliedName: input.name,
        previousInventoryCode: input.space.inventory_code ?? null,
        previousInventoryCodeNormalized: input.space.inventory_code_normalized ?? null,
        previousName: input.space.name ?? null,
    });
    logSpaceIdentity("reference_changed", {
        modelVersionId: input.modelVersionId, spaceId: input.space.id, ifcGlobalId: input.guid,
        previousReference: input.space.inventory_code_normalized, newReference: input.code,
    });
}

/**
 * After a real canonical-index unique conflict, re-resolve the concurrently
 * created row and VERIFY it before reuse (§6): same linked_model_id, byte-equal
 * GlobalId (guaranteed by the BINARY-scoped lookup), non-null spaces.id and
 * space_uuid, no canonical/binding inconsistency (already checked for the scope).
 * The Reference of the raced row is treated as administrative metadata: if it
 * differs from the current candidate it is updated under the SAME transitional
 * collision rules — never silently overwriting another space's Reference.
 */
async function resolveRacedCanonicalIdentity(input: {
    linkedModelId: number; guid: string; code: string; rawValue: string; name: string | null;
    modelVersionId: number; originalError: any; record: ReferenceUpdateRecord[];
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
    await applyReferenceUpdateIfChanged({
        space: raced, code: input.code, rawValue: input.rawValue, name: input.name,
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
    /**
     * Lossless per-IfcSpace occurrences (ADR-0051 §1) — MANDATORY. The GlobalId-keyed
     * `candidates` array has already collapsed duplicates and can never reveal them, so
     * it is never accepted as duplicate-safety evidence. The occurrences are validated
     * by the SAME shared contract validator the orchestration preflight uses and must
     * reconcile exactly with the candidate GlobalId set (typed as `unknown` so the
     * runtime — not the compiler — rejects missing/undefined/non-array/inconsistent
     * inputs at this independent boundary).
     */
    occurrences: unknown;
}): Promise<SpaceIdentityOutcome> {

    // MANDATORY lossless occurrence contract (ADR-0051 §1/§5-v4) — validated FIRST, before
    // ANY schema/database access. This is an INDEPENDENT boundary that never trusts
    // `input.candidates` as duplicate-safety evidence. The shared validator checks the
    // runtime SHAPE of every element (non-null object, string GlobalId, positive-integer
    // entity id, well-typed optional fields) and rejects missing/undefined/non-array/
    // empty-with-spaces occurrences, invalid or duplicate exact GlobalIds, an occurrence
    // set that does not exactly reconcile with the candidate GlobalIds, and duplicated
    // occurrence entity ids. Because it runs before the DB, a direct call with malformed
    // occurrences returns the contract error even when the database is unavailable. It is
    // defence in depth: the orchestration preflight already ran the same validator before
    // saveInventorySnapshot.
    validateLosslessOccurrenceContract({
        occurrences: input.occurrences,
        expectedGuids: input.candidates.map((c) => c.guid),
        modelVersionId: input.modelVersionId,
        linkedModelId: input.linkedModelId,
    });

    const resolver = getSpaceIdentityResolver();

    // Stage 0A schema precondition + scope canonical integrity (ADR-0051 §4).
    // A precise operational/configuration error is raised here; the runtime never
    // recreates schema, runs a migration, or falls back to Reference.
    await spaceDb.assertCanonicalSpaceSchema();
    const inconsistencies = await spaceDb.findScopeCanonicalInconsistencies(input.linkedModelId);
    if (inconsistencies.nullCanonical.length > 0) {
        throw new SpaceCanonicalSchemaError(
            "canonical_inconsistency",
            `Existing spaces have a NULL canonical ifc_global_id (ids: ${inconsistencies.nullCanonical.join(", ")}). Stage 0A backfill is incomplete; refusing to proceed without repair.`,
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
            invalid_reference: [],
            duplicate_reference: [],
            reused_spaces: 0,
            created_spaces: 0,
            isAuthoritative,
            authorityModelId,
        },
        presentNormalizedCodes: [],
        spaceInfoByGuid: {},
        referenceUpdates: [],
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
                    é a MESMA — groupDuplicateReferences) -------- */
    const duplicates = groupDuplicateReferences(resolved);

    for (const [code, entries] of duplicates) {
        for (const entry of entries) entry.result.status = "duplicate";
        outcome.diagnostics.duplicate_reference.push({
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

    if (outcome.diagnostics.duplicate_reference.length > 0) {
        logSpaceIdentity("duplicate_reference", {
            modelVersionId: input.modelVersionId,
            duplicates: outcome.diagnostics.duplicate_reference,
            isAuthoritative,
        });

        // Duplicação ambígua numa versão do modelo espacial autoritativo
        // impede a ativação (a falha aciona a compensação do upload).
        if (isAuthoritative) {
            const codes = outcome.diagnostics.duplicate_reference.map((d: any) => d.code).join(", ");
            throw new DuplicateSpaceReferenceError(
                `Duplicate space inventory code(s) in authoritative spatial model: ${codes}`,
                outcome.diagnostics.duplicate_reference
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
            outcome.diagnostics.invalid_reference.push({ guid: candidate.guid, reasons: result.reasons });
            continue;
        }
        if (result.status === "duplicate") {
            // não autoritativo: não escolher silenciosamente — sem binding
            continue;
        }

        const code = result.normalizedValue!;
        const name = candidate.longName ?? candidate.name ?? null;

        // ---- Canonical identity lookup: linked_model_id + GlobalId ----
        let space = await spaceDb.findByScopeAndGlobalId(input.linkedModelId, candidate.guid);

        if (space) {
            // Same persistent space (same GlobalId). Preserve id/space_uuid/history.
            // If the current administrative Reference changed, update ONLY the
            // current projection (§6) with a transitional collision guard — never
            // treat it as a new space, never overwrite another space's Reference.
            await applyReferenceUpdateIfChanged({
                space, code, rawValue: result.rawValue!, name,
                linkedModelId: input.linkedModelId, guid: candidate.guid, modelVersionId: input.modelVersionId,
                record: outcome.referenceUpdates,
            });
            outcome.diagnostics.reused_spaces++;
        } else {
            // New GlobalId → new persistent space. Transitional Reference collision
            // (§3/§7): a DIFFERENT GlobalId must never reuse a persistent space just
            // because its Reference matches. Detect deterministically BEFORE the
            // insert — do not rely on the duplicate-key exception.
            const clash = await spaceDb.findByScopeAndCode(input.linkedModelId, code);
            if (clash) {
                throw new TransitionalReferenceCollisionError(
                    `IfcSpace GlobalId ${candidate.guid} indicates a NEW persistent space, but its Reference '${code}' is still assigned to persistent space id ${clash.id} (a different GlobalId). The legacy Reference uniqueness constraint uq_spaces_scope_code is still active and is removed only in a later stage; no row was created or reassigned.`,
                    { ifcGlobalId: candidate.guid, newReference: code, conflictingSpaceId: clash.id, linkedModelId: input.linkedModelId },
                );
            }
            try {
                const created = await spaceDb.createSpace({
                    linkedModelId: input.linkedModelId,
                    ifcGlobalId: candidate.guid,
                    inventoryCode: result.rawValue!,
                    inventoryCodeNormalized: code,
                    name,
                });
                space = { id: created.spaceId };
                outcome.createdSpaceIds.push(created.spaceId);
                outcome.diagnostics.created_spaces++;
            } catch (error: any) {
                // Concurrency backstop (§5/§6/§12) — the unique indexes are the final
                // authority. The error is classified by its STRUCTURED index name,
                // never by prose, and never falls back to Reference.
                const kind = classifyDuplicateKey(error);
                if (kind === "canonical_globalid") {
                    // Another activation created the SAME canonical identity first;
                    // re-resolve and VERIFY the raced row before reusing it (§6).
                    space = await resolveRacedCanonicalIdentity({
                        linkedModelId: input.linkedModelId, guid: candidate.guid,
                        code, rawValue: result.rawValue!, name,
                        modelVersionId: input.modelVersionId, originalError: error,
                        record: outcome.referenceUpdates,
                    });
                    outcome.diagnostics.reused_spaces++;
                } else if (kind === "legacy_reference") {
                    // A Reference-uniqueness collision surfaced concurrently.
                    throw new TransitionalReferenceCollisionError(
                        `IfcSpace GlobalId ${candidate.guid} could not create a new persistent space because Reference '${code}' collided with the transitional legacy uniqueness constraint uq_spaces_scope_code. No row was created or reassigned.`,
                        { ifcGlobalId: candidate.guid, newReference: code, linkedModelId: input.linkedModelId },
                    );
                } else {
                    // "unrelated" duplicate key or any non-duplicate error: never
                    // misread as a canonical race or a Reference collision.
                    throw error;
                }
            }
        }

        await spaceDb.createBinding({
            spaceId: space.id,
            modelVersionId: input.modelVersionId,
            entityId: candidate.entityId,
            // Binding GlobalId is byte-identical to the canonical spaces.ifc_global_id
            // (ADR-0051 §10) — the binding is keyed by the same GlobalId used above.
            ifcGuid: candidate.guid,
            inventoryCodeSnapshot: result.rawValue!,
            nameSnapshot: candidate.name ?? null,
            longNameSnapshot: candidate.longName ?? null,
        });
        outcome.bindingsCreated++;
        outcome.presentNormalizedCodes.push(code);
        outcome.spaceInfoByGuid[candidate.guid] = { spaceId: space.id, code };
    }
    } catch (rawError: unknown) {
        // §6-v4: NORMALIZE the captured value to a stable Error BEFORE attaching any
        // compensation metadata. A string/number/null/object throwable has no assignable
        // slots (module scope is strict mode, so `"x".createdSpaceIds = …` itself throws a
        // TypeError that would REPLACE the real failure); normalizing first guarantees the
        // metadata is always attachable and never manufactures a second error that hides
        // the original. An Error is kept by identity; a non-Error original is preserved as
        // a sanitized `cause` so the failure stays understandable. The prior Reference
        // values remain available to compensation via `referenceUpdates`.
        const error: any = rawError instanceof Error
            ? rawError
            : Object.assign(new Error(`space identity persistence failed: ${String(rawError)}`), { cause: rawError });
        // Falha a meio da persistência: anexar os espaços já criados por esta
        // operação para a compensação do upload poder removê-los com segurança.
        error.createdSpaceIds = outcome.createdSpaceIds;
        // Attach the Reference changes applied to REUSED spaces so the upload
        // compensation can restore them (§6.B) — deleting orphan spaces never undoes
        // an UPDATE to a pre-existing row.
        error.referenceUpdates = outcome.referenceUpdates;
        throw error;
    }

    if (outcome.diagnostics.ignored_missing_inventory_code.length > 0) {
        logSpaceIdentity("ignored_missing_inventory_code", {
            modelVersionId: input.modelVersionId,
            guids: outcome.diagnostics.ignored_missing_inventory_code,
        });
    }
    if (outcome.diagnostics.invalid_reference.length > 0) {
        logSpaceIdentity("invalid_reference", {
            modelVersionId: input.modelVersionId,
            entries: outcome.diagnostics.invalid_reference,
        });
    }

    return outcome;
}

/**
 * Reconciliação de estados APÓS ativação bem-sucedida de uma versão do modelo
 * espacial autoritativo. Nunca apaga espaços; ausência marca 'absent'
 * (retired é operação explícita futura). Falhas aqui são registadas mas não
 * revertem a ativação (o estado reconcilia-se no upload seguinte).
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
