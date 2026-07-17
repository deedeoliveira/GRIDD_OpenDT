import spaceDb from "../utils/spaceDatabase.ts";
import { getSpaceIdentityResolver } from "../identity/spaceIdentityProvider.ts";
import type { SpaceIdentityResult } from "../identity/types.ts";

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
