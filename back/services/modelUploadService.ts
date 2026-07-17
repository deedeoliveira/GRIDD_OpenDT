import fs from "fs";
import modelDb from "../utils/modelDatabase.ts";
import versionDb from "../utils/modelVersionDatabase.ts";
import inventoryDb from "../utils/inventoryDatabase.ts";
import spaceDb from "../utils/spaceDatabase.ts";
import { fetchInventory } from "./preprocessService.ts";
import { getModelRequirementsValidator } from "../requirements/modelRequirementsProvider.ts";
import { ModelRequirementsError } from "../requirements/modelRequirementsTypes.ts";
import { persistSpaceIdentities, reconcileSpaceStatusesAfterActivation, type SpaceCandidateInput } from "./spaceIdentityService.ts";
import { persistAssetsForVersion, reconcileAssetLifecycleAfterActivation } from "./assetInventoryService.ts";
import persistentAssetDb from "../utils/persistentAssetDatabase.ts";
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
 *  5. model_requirements_preflight (SPACE-, PROXY- e EQUIPMENT-) e depois
 *     snapshot de inventário (entities; transacional); ativos via
 *     identidade persistente + política de reservabilidade;
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
    let createdAssetIds: number[] = [];

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

        /* -------- 4. processamento Python (extração, sem persistência) -------- */
        stage = "processing";
        const versionFileUrl = `${selfApiBase()}/api/model/versions/${versionId}/download`;
        const extracted = await fetchInventory(modelId, versionFileUrl);
        const inventoryData = extracted.inventoryData;

        /* -------- 5. model_requirements_preflight: requisitos de informação
                       (espaciais SPACE-*, proxies PROXY-*, equipamentos
                       EQUIPMENT-*) via provider configurável — ANTES de criar
                       entities/assets/spaces/bindings/casos. Falha de
                       requisitos ≠ decisão de política. -------- */
        stage = "model_requirements_preflight";
        const requirements = await getModelRequirementsValidator().validate(extracted, {
            linkedModelId: linkedParentId,
            modelId,
            modelVersionId: versionId,
        });

        if (requirements.status !== "conforms") {
            const errors = requirements.findings.filter((f) => f.severity === "error");
            const requirementIds = [...new Set(errors.map((f) => f.requirementId))];
            const detail = errors.map((f) => {
                const parts = [f.message];
                const ctx: string[] = [];
                if (f.ifcClass) ctx.push(`class=${f.ifcClass}`);
                if (f.entityGuid) ctx.push(`guid=${f.entityGuid}`);
                if (f.name) ctx.push(`name=${f.name}`);
                if (f.objectType) ctx.push(`objectType=${f.objectType}`);
                if (f.tag !== null && f.tag !== undefined) ctx.push(`tag=${f.tag}`);
                if ((f.details as any)?.motivo) ctx.push(`motivo=${(f.details as any).motivo}`);
                if (ctx.length) parts.push(`[${ctx.join(", ")}]`);
                return parts.join(" ");
            }).join(" | ");

            throw new ModelRequirementsError(
                detail,
                `${requirementIds.join(", ")} — ${errors.length} information requirement violation(s)`,
                errors,
                requirements.profileId
            );
        }

        /* -------- 6. inventário de entities (snapshot da versão) -------- */
        stage = "inventory";
        const { spaceEntityIdsByGuid, elementEntityIdsByGuid } =
            await inventoryDb.saveInventorySnapshot(versionId, inventoryData);

        /* -------- 7. identidade persistente dos espaços (Prompt 3) -------- */
        stage = "spatial_identity";
        let presentNormalizedCodes: string[] = [];
        let spaceInfoByGuid: Record<string, { spaceId: number; code: string }> = {};

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
            spaceInfoByGuid = spatial.spaceInfoByGuid;
        }

        /* -------- 8. ativos persistentes: reconciliação de identidade,
                       política de reservabilidade e bindings (Prompt 4) -------- */
        stage = "asset_reconciliation";
        if (linkedParentId !== null) {
            const assetOutcome = await persistAssetsForVersion({
                linkedModelId: linkedParentId,
                modelId,
                modelVersionId: versionId,
                inventoryData,
                spaceEntityIdsByGuid,
                elementEntityIdsByGuid,
                spaceInfoByGuid,
            });
            createdAssetIds = assetOutcome.createdAssetIds;
        }

        /* -------- 9. ativação e troca da versão corrente -------- */
        stage = "activation";
        await versionDb.activateVersion(modelId, versionId);

        /* -------- 10. reconciliação pós-ativação: estados dos espaços e
                        ciclo de vida dos ativos (nunca apaga) -------- */
        if (linkedParentId !== null) {
            await reconcileSpaceStatusesAfterActivation({
                linkedModelId: linkedParentId,
                modelId,
                presentNormalizedCodes,
            });
        }
        await reconcileAssetLifecycleAfterActivation({
            linkedModelId: linkedParentId,
            modelId,
            currentVersionId: versionId,
        });

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
            // ativos: bindings e casos da versão falhada primeiro (FK para
            // entities); ativos criados EXCLUSIVAMENTE por esta operação só
            // são removidos se não tiverem bindings de outras versões,
            // reservas nem referências
            try {
                await persistentAssetDb.deleteBindingsForVersion(versionId);
                await persistentAssetDb.deleteCasesForVersion(versionId);
                const assetsToRemove = [...createdAssetIds, ...(error?.createdAssetIds ?? [])];
                await persistentAssetDb.deleteAssetsWithoutReferences(assetsToRemove);
            } catch (e) {
                logUploadFailure("compensation_assets", e, { modelId, versionId });
            }
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
            try {
                const failedStage = error?.uploadStage ?? stage;
                const reason = error?.failureReason ?? error?.message ?? String(error);
                await versionDb.markFailed(versionId, `${failedStage}: ${reason}`);
            } catch (e) {
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
