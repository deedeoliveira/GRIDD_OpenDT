import spaceDb from "../utils/spaceDatabase.ts";
import { getSpaceIdentityResolver } from "../identity/spaceIdentityProvider.ts";
import { isValidIfcGlobalId } from "../utils/ifcGlobalId.ts";
import type { SpaceIdentityResult } from "../identity/types.ts";
import type { ExtractedIfcModel, SpaceOccurrence } from "../requirements/modelRequirementsTypes.ts";

/**
 * Lossless per-IfcSpace occurrences (ADR-0051 Stage 0B §1). Uses the Python
 * `spaceOccurrences` list when present — the only source that can reveal a
 * duplicate exact GlobalId. Falls back to one occurrence per inventoryData key
 * (which, being GlobalId-keyed, has already collapsed duplicates and therefore
 * cannot reveal them) so older extraction sources keep working without claiming
 * duplicate detection.
 */
export function deriveSpaceOccurrences(extracted: Pick<ExtractedIfcModel, "spaceOccurrences" | "inventoryData">): SpaceOccurrence[] {
    if (Array.isArray(extracted.spaceOccurrences)) return extracted.spaceOccurrences;
    // Fallback carries the raw psets verbatim (this layer names no pset); the
    // identity Reference is interpreted only in the identity/model-intake layer.
    return Object.entries(extracted.inventoryData ?? {}).map(([guid, s]: [string, any]) => ({
        entityId: null,
        guid,
        name: s?.spaceName ?? null,
        longName: s?.spaceLongName ?? null,
        storeyName: s?.storeyName ?? null,
        psets: s?.psets ?? null,
    }));
}

/**
 * spatial_preflight (revisão do Prompt 3): validação obrigatória dos
 * requisitos de informação espacial, executada DEPOIS do processamento
 * Python e ANTES de qualquer persistência (entities, assets, spaces,
 * space_bindings).
 *
 * É uma falha de requisitos de informação/pré-processamento espacial —
 * NÃO é uma decisão de política: não passa pelo avaliador de política de
 * reservas, não produz resultados de política e não altera a regra legada.
 *
 * Regra estrita, aplicada APENAS ao modelo espacial autoritativo (ADR-0006;
 * federação com um único modelo → esse modelo é autoritativo):
 *  - zero IfcSpace                         → rejeição;
 *  - qualquer IfcSpace sem código válido   → rejeição (sem aceitação parcial);
 *  - códigos duplicados                    → rejeição (regra do ADR-0007,
 *    movida para antes da persistência).
 *
 * Modelos não autoritativos (disciplinares) continuam livres: podem não ter
 * IfcSpace e espaços sem código seguem o comportamento anterior (diagnóstico).
 */

export type SpatialPreflightCode =
    | "no_ifcspace"
    | "invalid_references"
    | "duplicate_references";

export class SpatialPreflightError extends Error {
    readonly statusCode = 422;
    readonly code: SpatialPreflightCode;
    /** Razão curta para failure_reason (prefixada com a etapa pelo upload). */
    readonly failureReason: string;
    readonly diagnostics: any[];

    constructor(code: SpatialPreflightCode, userMessage: string, failureReason: string, diagnostics: any[]) {
        super(userMessage);
        this.name = "SpatialPreflightError";
        this.code = code;
        this.failureReason = failureReason;
        this.diagnostics = diagnostics;
    }
}

export interface SpatialPreflightInput {
    linkedModelId: number | null;
    modelId: number;
    modelVersionId: number;
    /** Payload do Python: um item por IfcSpace (guid → dados + psets). */
    inventoryData: Record<string, any>;
}

export interface SpatialPreflightOutcome {
    isAuthoritative: boolean;
    authorityModelId: number | null;
    spaceCount: number;
}

/**
 * Agrupa candidatos válidos por código normalizado e devolve os grupos
 * duplicados. Lógica ÚNICA de deteção de duplicações, partilhada com a
 * persistência (spaceIdentityService) como verificação defensiva.
 */
export function groupDuplicateReferences<T extends { result: SpaceIdentityResult }>(
    resolved: T[]
): Map<string, T[]> {
    const byCode = new Map<string, T[]>();
    for (const entry of resolved) {
        if (entry.result.status !== "valid") continue;
        const code = entry.result.normalizedValue!;
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code)!.push(entry);
    }
    return new Map([...byCode].filter(([, group]) => group.length > 1));
}

/**
 * Groups candidate IfcSpaces by EXACT case-sensitive GlobalId and returns the
 * duplicated groups. Under the Stage 0B byte-exact identity contract, GlobalIds
 * differing only by letter case are DISTINCT and never grouped. Shared with the
 * persistence path as the user-facing duplicate detector (not a DB exception).
 */
export function groupDuplicateGlobalIds<T extends { guid: string }>(candidates: T[]): Map<string, T[]> {
    const byGuid = new Map<string, T[]>();
    for (const c of candidates) {
        // Only VALID GlobalIds participate in duplicate detection; an invalid one
        // is handled by the invalid-GlobalId gate, not misreported as a duplicate.
        if (!isValidIfcGlobalId(c.guid)) continue;
        if (!byGuid.has(c.guid)) byGuid.set(c.guid, []);
        byGuid.get(c.guid)!.push(c);
    }
    return new Map([...byGuid].filter(([, group]) => group.length > 1));
}

function logPreflight(event: string, payload: Record<string, unknown>) {
    console.log(JSON.stringify({ type: "spatial_preflight", event, at: new Date().toISOString(), ...payload }));
}

export async function runSpatialPreflight(input: SpatialPreflightInput): Promise<SpatialPreflightOutcome> {
    const authorityModelId = input.linkedModelId === null
        ? null
        : await spaceDb.resolveSpatialAuthority(input.linkedModelId);
    const isAuthoritative = authorityModelId !== null && authorityModelId === input.modelId;

    const spaces = Object.entries(input.inventoryData ?? {});
    const outcome: SpatialPreflightOutcome = { isAuthoritative, authorityModelId, spaceCount: spaces.length };

    if (!isAuthoritative) {
        // Modelos disciplinares/não autoritativos (ou autoridade indeterminada,
        // ou sem federação): sem validação estrita — comportamento anterior.
        return outcome;
    }

    /* ---- 1. modelo espacial autoritativo sem IfcSpace ---- */
    if (spaces.length === 0) {
        const error = new SpatialPreflightError(
            "no_ifcspace",
            "The spatial model cannot be processed because it contains no IfcSpace elements.",
            "no IfcSpace found",
            []
        );
        logPreflight("no_ifcspace", { modelVersionId: input.modelVersionId, modelId: input.modelId });
        throw error;
    }

    /* ---- 2. todos os IfcSpace devem ter código válido ---- */
    const resolver = getSpaceIdentityResolver();
    const resolved: { guid: string; space: any; result: SpaceIdentityResult; index: number }[] = [];

    for (const [index, [guid, space]] of spaces.entries()) {
        const result = await resolver.resolve(
            { guid, name: space.spaceName ?? null, longName: space.spaceLongName ?? null, psets: space.psets ?? null },
            { linkedModelId: input.linkedModelId!, modelId: input.modelId, modelVersionId: input.modelVersionId }
        );
        resolved.push({ guid, space, result, index });
    }

    const invalid = resolved.filter((r) => r.result.status !== "valid");

    if (invalid.length > 0) {
        const source = resolved[0]!.result.source;
        const diagnostics = invalid.map((r) => ({
            guid: r.guid,
            name: r.space.spaceName ?? null,
            longName: r.space.spaceLongName ?? null,
            index: r.index,
            motivo: r.result.reasonCode === "missing" ? "missing_reference"
                : r.result.reasonCode === "empty_or_whitespace" ? "empty_reference"
                : "invalid_reference_type",
        }));

        const error = new SpatialPreflightError(
            "invalid_references",
            `The spatial model cannot be processed because one or more IfcSpace elements do not contain a valid ${source}. ` +
            `${invalid.length} of ${resolved.length} IfcSpace elements are missing a valid inventory reference.`,
            `${invalid.length} of ${resolved.length} IfcSpace elements without a valid inventory reference`,
            diagnostics
        );
        logPreflight("invalid_references", { modelVersionId: input.modelVersionId, diagnostics });
        throw error;
    }

    /* ---- 3. duplicações (antes da persistência) ---- */
    const duplicates = groupDuplicateReferences(resolved);

    if (duplicates.size > 0) {
        const codes = [...duplicates.keys()];
        const diagnostics = [...duplicates].map(([code, group]) => ({
            code,
            modelVersionId: input.modelVersionId,
            modelId: input.modelId,
            linkedModelId: input.linkedModelId,
            entities: group.map((g: any) => ({ guid: g.guid, name: g.space.spaceName ?? null })),
        }));

        const error = new SpatialPreflightError(
            "duplicate_references",
            `Duplicate space inventory code(s) in authoritative spatial model: ${codes.join(", ")}`,
            `duplicate inventory code(s): ${codes.join(", ")}`,
            diagnostics
        );
        logPreflight("duplicate_references", { modelVersionId: input.modelVersionId, diagnostics });
        throw error;
    }

    return outcome;
}
