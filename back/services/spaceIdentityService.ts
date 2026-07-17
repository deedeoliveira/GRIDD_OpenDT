import spaceDb from "../utils/spaceDatabase.ts";
import { getSpaceIdentityResolver } from "../identity/spaceIdentityProvider.ts";
import type { SpaceIdentityResult } from "../identity/types.ts";

/**
 * Serviço de domínio da identidade espacial (Prompt 3).
 *
 * Regras de identidade (testadas):
 *  - mesmo Reference + GUID diferente  → mesmo space_id;
 *  - mesmo Reference + nome diferente  → mesmo space_id;
 *  - GUID igual + Reference diferente  → espaço persistente diferente;
 *  - Reference novo                    → espaço novo;
 *  - Reference ausente/ inválido       → sem espaço persistente (diagnóstico;
 *    a entity, o viewer e o comportamento legado de ativos não mudam).
 *
 * O GUID serve apenas para rastreabilidade/diagnóstico — nunca é critério de
 * identidade nem de desempate. Não há inferência de linhagem (divisão/fusão/
 * renumeração criam identidades novas; ver ADR e documentação da etapa).
 */

export class DuplicateSpaceReferenceError extends Error {
    readonly diagnostics: any[];
    constructor(message: string, diagnostics: any[]) {
        super(message);
        this.name = "DuplicateSpaceReferenceError";
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
}

function logSpaceIdentity(event: string, payload: Record<string, unknown>) {
    console.log(JSON.stringify({ type: "space_identity", event, at: new Date().toISOString(), ...payload }));
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
}): Promise<SpaceIdentityOutcome> {

    const resolver = getSpaceIdentityResolver();
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

    /* -------- 2. detetar duplicações no contexto da versão -------- */
    const byCode = new Map<string, { candidate: SpaceCandidateInput; result: SpaceIdentityResult }[]>();
    for (const entry of resolved) {
        if (entry.result.status !== "valid") continue;
        const code = entry.result.normalizedValue!;
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code)!.push(entry);
    }
    const duplicates = new Map([...byCode].filter(([, group]) => group.length > 1));

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
        let space = await spaceDb.findByScopeAndCode(input.linkedModelId, code);

        if (space) {
            outcome.diagnostics.reused_spaces++;
        } else {
            const created = await spaceDb.createSpace({
                linkedModelId: input.linkedModelId,
                inventoryCode: result.rawValue!,
                inventoryCodeNormalized: code,
                name: candidate.longName ?? candidate.name ?? null,
            });
            space = { id: created.spaceId };
            outcome.createdSpaceIds.push(created.spaceId);
            outcome.diagnostics.created_spaces++;
        }

        await spaceDb.createBinding({
            spaceId: space.id,
            modelVersionId: input.modelVersionId,
            entityId: candidate.entityId,
            ifcGuid: candidate.guid,
            inventoryCodeSnapshot: result.rawValue!,
            nameSnapshot: candidate.name ?? null,
            longNameSnapshot: candidate.longName ?? null,
        });
        outcome.bindingsCreated++;
        outcome.presentNormalizedCodes.push(code);
    }
    } catch (error: any) {
        // Falha a meio da persistência: anexar os espaços já criados por esta
        // operação para a compensação do upload poder removê-los com segurança.
        error.createdSpaceIds = outcome.createdSpaceIds;
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
