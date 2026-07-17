import fs from "fs";
import modelDb from "../utils/modelDatabase.ts";
import versionDb from "../utils/modelVersionDatabase.ts";
import inventoryDb from "../utils/inventoryDatabase.ts";
import spaceDb from "../utils/spaceDatabase.ts";
import { runPreprocess } from "./preprocessService.ts";
import { persistSpaceIdentities, reconcileSpaceStatusesAfterActivation, type SpaceCandidateInput } from "./spaceIdentityService.ts";
import { hashFile, promoteFile, removeTempFile, removeVersionDir, versionStorageKey } from "../utils/storage.ts";

/**
 * Fluxo de upload por etapas (Prompt 2).
 *
 * MySQL e sistema de ficheiros não participam da mesma transação, portanto
 * NÃO há atomicidade total: cada etapa tem compensação explícita e, em
 * qualquer falha, a versão anteriormente corrente permanece corrente e o
 * viewer continua a funcionar.
 *
 * Etapas:
 *  1. hash + tamanho do ficheiro temporário;
 *  2. reservar version_number e criar a linha em 'processing' (transação);
 *  3. promover o ficheiro para models/{modelId}/versions/{versionId}/model.ifc
 *     (nunca sobrescreve; hash verificado após a escrita);
 *  4. processamento Python/IfcOpenShell sobre O FICHEIRO DA VERSÃO (o Python
 *     descarrega via /api/model/versions/:id/download — por isso a promoção
 *     acontece antes do processamento; ver ADR-0002);
 *  5. snapshot de inventário (entities/assets; transacional; decisão de
 *     reservabilidade via provider de política);
 *  6. ativação (transação): versão → active, anterior → archived,
 *     models.current_version_id → nova versão.
 *
 * Compensação em falha (etapas 3–6): inventário da versão apagado, ficheiro
 * promovido removido, linha marcada 'failed' com failure_reason (preservada
 * para diagnóstico), log estruturado model_upload_failure. O temporário é
 * sempre limpo (finally).
 */

export interface UploadInput {
    tempFilePath: string;
    originalFilename: string;
    name?: string | undefined;
    /** Quando presente: nova revisão deste modelo lógico. */
    modelId?: number | undefined;
    /** Quando presente (sem modelId): novo modelo dentro desta federação. */
    linkedParentId?: number | undefined;
    description?: string | null;
    createdBy?: string | null;
}

export interface UploadResult {
    modelId: number;
    linkedParentId: number | null;
    versionId: number;
    versionNumber: number;
    fileHash: string;
    fileSize: number;
    isNewModel: boolean;
}

function selfApiBase(): string {
    return process.env.SELF_API_BASE ?? `http://localhost:${process.env.PORT || 3000}`;
}

function logUploadFailure(stage: string, error: any, context: Record<string, unknown>) {
    console.error(JSON.stringify({
        type: "model_upload_failure",
        stage,
        error: String(error?.message ?? error),
        at: new Date().toISOString(),
        ...context,
    }));
}

export async function handleModelUpload(input: UploadInput): Promise<UploadResult> {
    let stage = "before_version";
    let modelId = input.modelId ?? null;
    let linkedParentId: number | null = input.linkedParentId ?? null;
    let versionId: number | null = null;
    let promoted = false;
    let isNewModel = false;
    let createdSpaceIds: number[] = [];

    try {
        /* -------- modelo lógico: reutilizar ou criar -------- */
        if (modelId) {
            const existing = await modelDb.getModelMetadata(String(modelId)) as any;
            if (existing instanceof Error) {
                throw new Error(`Model with id ${modelId} not found`);
            }
            linkedParentId = existing.linked_parent_id ?? null;
        } else {
            const name = input.name || input.originalFilename.split(".")[0];
            const model = await modelDb.uploadModel(name!, null as any, input.linkedParentId as any) as any;
            if (model instanceof Error || !model.id) {
                throw new Error("Model creation failed");
            }
            modelId = Number(model.id);
            linkedParentId = model.linkedParentId ? Number(model.linkedParentId) : null;
            isNewModel = true;
        }

        /* -------- 1. hash e tamanho -------- */
        const { fileHash, fileSize } = hashFile(input.tempFilePath);

        /* -------- 2. reservar versão ('processing') -------- */
        const reserved = await versionDb.reserveVersion({
            modelId,
            originalFilename: input.originalFilename,
            fileHash,
            fileSize,
            description: input.description ?? null,
            createdBy: input.createdBy ?? null,
        });
        versionId = reserved.versionId;

        /* -------- 3. promover o ficheiro (imutável) -------- */
        stage = "promotion";
        const storageKey = versionStorageKey(modelId, versionId);
        promoteFile(input.tempFilePath, storageKey, fileHash);
        promoted = true;
        await versionDb.setStorageKey(versionId, storageKey);

        /* -------- 4+5. processamento + inventário -------- */
        stage = "processing";
        const versionFileUrl = `${selfApiBase()}/api/model/versions/${versionId}/download`;
        const { inventoryData, spaceEntityIdsByGuid } = await runPreprocess(modelId, versionId, versionFileUrl);

        /* -------- 6. identidade persistente dos espaços (Prompt 3) -------- */
        stage = "spatial_identity";
        let presentNormalizedCodes: string[] = [];

        if (linkedParentId !== null) {
            const candidates: SpaceCandidateInput[] = Object.entries(inventoryData as Record<string, any>)
                .filter(([guid]) => spaceEntityIdsByGuid[guid] !== undefined)
                .map(([guid, space]) => ({
                    guid,
                    name: space.spaceName ?? null,
                    longName: space.spaceLongName ?? null,
                    psets: space.psets ?? null,
                    entityId: spaceEntityIdsByGuid[guid]!,
                }));

            const spatial = await persistSpaceIdentities({
                linkedModelId: linkedParentId,
                modelId,
                modelVersionId: versionId,
                candidates,
            });

            createdSpaceIds = spatial.createdSpaceIds;
            presentNormalizedCodes = spatial.presentNormalizedCodes;
        }

        /* -------- 7. ativação e troca da versão corrente -------- */
        stage = "activation";
        await versionDb.activateVersion(modelId, versionId);

        /* -------- 8. reconciliação de estados espaciais (pós-ativação,
                       só no modelo espacial autoritativo; nunca apaga) -------- */
        if (linkedParentId !== null) {
            await reconcileSpaceStatusesAfterActivation({
                linkedModelId: linkedParentId,
                modelId,
                presentNormalizedCodes,
            });
        }

        return {
            modelId,
            linkedParentId,
            versionId,
            versionNumber: reserved.versionNumber,
            fileHash,
            fileSize,
            isNewModel,
        };

    } catch (error: any) {
        logUploadFailure(stage, error, { modelId, versionId });

        /* -------- compensações: a versão anterior continua corrente -------- */
        if (versionId) {
            // bindings primeiro (FK para entities); depois espaços criados
            // EXCLUSIVAMENTE por esta operação e sem outros bindings —
            // espaços preexistentes nunca são apagados
            try {
                await spaceDb.deleteBindingsForVersion(versionId);
                const toRemove = [...createdSpaceIds, ...(error?.createdSpaceIds ?? [])];
                await spaceDb.deleteSpacesWithoutBindings(toRemove);
            } catch (e) {
                logUploadFailure("compensation_spaces", e, { modelId, versionId });
            }
            try { await inventoryDb.deleteInventoryForVersion(versionId); } catch (e) {
                logUploadFailure("compensation_inventory", e, { modelId, versionId });
            }
            try { await versionDb.markFailed(versionId, `${stage}: ${error?.message ?? error}`); } catch (e) {
                logUploadFailure("compensation_mark_failed", e, { modelId, versionId });
            }
            if (promoted && modelId) {
                try { removeVersionDir(modelId, versionId); } catch (e) {
                    logUploadFailure("compensation_remove_file", e, { modelId, versionId });
                }
            }
        }

        throw error;
    } finally {
        removeTempFile(input.tempFilePath);
    }
}
