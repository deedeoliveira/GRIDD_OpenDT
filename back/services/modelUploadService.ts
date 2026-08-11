import fs from "fs";
import modelDb from "../utils/modelDatabase.ts";
import versionDb from "../utils/modelVersionDatabase.ts";
import inventoryDb from "../utils/inventoryDatabase.ts";
import spaceDb from "../utils/spaceDatabase.ts";
import { fetchInventory } from "./preprocessService.ts";
import { assertSupportedIfc4x3Schema } from "../utils/ifcSchemaSupport.ts";
import { getModelRequirementsValidator } from "../requirements/modelRequirementsProvider.ts";
import { ModelRequirementsError } from "../requirements/modelRequirementsTypes.ts";
import { ModelRequirementsValidationService } from "../requirements/modelRequirementsValidationService.ts";
import { persistSpaceIdentities, preflightSpaceOccurrences, reconcileSpaceStatusesAfterActivation, type SpaceCandidateInput } from "./spaceIdentityService.ts";
import { persistAssetsForVersion, reconcileAssetLifecycleAfterActivation } from "./assetInventoryService.ts";
import persistentAssetDb from "../utils/persistentAssetDatabase.ts";
import { classifyDuplicateKey } from "../utils/mysqlDuplicateKey.ts";
import { hashFile, promoteFile, removeTempFile, removeVersionDir, resolveStorageKey, versionStorageKey } from "../utils/storage.ts";
import { extractIfcModelFromFile } from "../requirements/ifcFileExtraction.ts";
import type { IntakeProfile } from "../modelIntake/modelIntakeTypes.ts";
import type { SemanticExecutionContext } from "../modelIntake/semanticExecutionContext.ts";
import { loadModelIntakeConfig } from "../modelIntake/modelIntakeConfig.ts";
import { SemanticMaterialisationService } from "../modelIntake/semanticMaterialisationService.ts";

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
    /**
     * Change C: the controlled-intake path carries the ONE pinned semantic execution
     * context captured at the start of `ModelIntakeService.createVersion`. `idsProfile`
     * was already resolved from `semanticContext.ids` through the pinned resolver by the
     * caller and is passed through unchanged as `profileOverride`; mapping and shapes are
     * NOT reconstructed here — the same context instance is threaded into
     * `SemanticMaterialisationService.materialise()`.
     */
    controlledIntake?: { idsProfile: IntakeProfile; semanticContext: SemanticExecutionContext };
}

export interface UploadResult {
    modelId: number;
    linkedParentId: number | null;
    versionId: number;
    versionNumber: number;
    fileHash: string;
    fileSize: number;
    isNewModel: boolean;
    versionUuid: string;
    previousCurrentVersionId: number | null;
    semanticMaterialisation: any | null;
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

/**
 * Compensating restore of the mutable space-metadata projections this operation applied
 * to REUSED (pre-existing) spaces (ADR-0052 §8) — the institutional inventory_code (from
 * IfcSpace.Name), its normalized form, and long_name (from IfcSpace.LongName). Called
 * while the linked_model space-metadata lock is STILL held. Each restore is CONDITIONAL on
 * the value we applied still being current (`restoreSpaceMetadata`), so a newer concurrent
 * successful change is never clobbered. Returns human-readable compensation-integrity
 * notes for the version failure reason:
 *  - zero rows restored: our value is no longer current (a newer change won, or the row is
 *    gone) — explained via a structured log, not treated as a failure;
 *  - a duplicate-key or other restore error: an explicit compensation-integrity failure,
 *    surfaced in the failure reason rather than merely logged.
 * spaces.id / space_uuid / ifc_global_id are never changed by compensation.
 */
async function restoreSpaceMetadataProjections(
    updates: Array<{ spaceId: number; appliedInventoryCode: string; appliedInventoryCodeNormalized: string; appliedLongName: string | null;
        previousInventoryCode: string | null; previousInventoryCodeNormalized: string | null; previousLongName: string | null }>,
    ctx: { modelId: number | null; versionId: number | null },
): Promise<string[]> {
    const issues: string[] = [];
    for (const u of updates) {
        try {
            const rows = await spaceDb.restoreSpaceMetadata(u);
            if (rows === 0) {
                // The FULL applied projection (inventory code + normalized + long_name) is
                // no longer current — a newer projection won or the row is gone. Visible in
                // the structured compensation report, never a silent success.
                logUploadFailure("compensation_space_metadata_noop",
                    new Error("restore matched 0 rows: the applied space-metadata projection is no longer current (a newer change won, or the row is absent) — left as-is, never overwritten"),
                    { ...ctx, spaceId: u.spaceId, appliedInventoryCodeNormalized: u.appliedInventoryCodeNormalized });
                issues.push(`space ${u.spaceId} metadata restore matched 0 rows (newer projection won or row absent; left as-is)`);
            }
        } catch (e: any) {
            logUploadFailure("compensation_space_metadata_failed", e, { ...ctx, spaceId: u.spaceId });
            const cause = classifyDuplicateKey(e) === "scope_inventory_code"
                ? "previous inventory code was reclaimed by another persistent space"
                : String(e?.code ?? e?.message ?? e);
            issues.push(`space ${u.spaceId} metadata restore failed (${cause})`);
        }
    }
    return issues;
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
    // Space-metadata changes applied to REUSED spaces (§8) — restored on failure
    // (deleting orphan spaces never undoes an UPDATE to a pre-existing row).
    let metadataUpdates: Array<{ spaceId: number; appliedInventoryCode: string; appliedInventoryCodeNormalized: string; appliedLongName: string | null;
        previousInventoryCode: string | null; previousInventoryCodeNormalized: string | null; previousLongName: string | null }> = [];
    let previousCurrentVersionId: number | null = null;
    let semanticMaterialisation: any | null = null;

    try {
        /* -------- modelo lógico: reutilizar ou criar -------- */
        if (modelId) {
            const existing = await modelDb.getModelMetadata(String(modelId)) as any;
            if (existing instanceof Error) {
                throw new Error(`Model with id ${modelId} not found`);
            }
            linkedParentId = existing.linked_parent_id ?? null;
            previousCurrentVersionId = (await versionDb.getCurrentVersion(modelId))?.id ?? null;
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
        // Pass the opaque numeric version id (never a URL). The Python service builds the
        // authenticated version-download URL itself from trusted configuration before it
        // attaches the internal-service token, so no caller can select the request target.
        const extracted = input.controlledIntake
            ? await extractIfcModelFromFile(resolveStorageKey(storageKey))
            : await fetchInventory(modelId, versionId);
        const inventoryData = extracted.inventoryData;

        /* -------- 4b. IFC4x3-only schema gate (ADR-0052 §A) — runs AFTER trustworthy
                        schema extraction but BEFORE requirements preflight and ANY
                        persistence (entities/spaces/assets/bindings/materialisation/
                        activation). Node classifies the ACTUAL schema identifier via the
                        single central gate — never the Python schemaSupported flag — so
                        IFC4 and IFC2X3 are rejected with one structured error. The reserved
                        version is compensated (marked failed) by the outer contract; no
                        durable rows remain and no activation occurs. -------- */
        stage = "ifc_schema_gate";
        assertSupportedIfc4x3Schema(extracted.schema);

        /* -------- 5. model_requirements_preflight: requisitos de informação
                       (espaciais SPACE-*, proxies PROXY-*, equipamentos
                       EQUIPMENT-*) via provider configurável — ANTES de criar
                       entities/assets/spaces/bindings/casos. Falha de
                       requisitos ≠ decisão de política. -------- */
        stage = "model_requirements_preflight";
        const requirements = await new ModelRequirementsValidationService().validate({
            ifcPath: resolveStorageKey(storageKey),
            extractedModel: extracted,
            context: { linkedModelId: linkedParentId, modelId, modelVersionId: versionId },
            projectValidator: getModelRequirementsValidator(),
            sourceKind: "upload",
            ...(input.controlledIntake ? { profileOverride: input.controlledIntake.idsProfile } : {}),
        });

        if (requirements.blocking) {
            const errors = requirements.findings.filter((f) => f.status === "fail");
            const requirementIds = [...new Set(errors.map((f) => f.requirementId))];
            const detail = errors.map((f) => {
                const parts = [f.message];
                const ctx: string[] = [];
                if (f.entityType) ctx.push(`class=${f.entityType}`);
                if (f.entityGuid) ctx.push(`guid=${f.entityGuid}`);
                if (ctx.length) parts.push(`[${ctx.join(", ")}]`);
                return parts.join(" ");
            }).join(" | ");

            throw new ModelRequirementsError(
                detail,
                `${requirementIds.join(", ")} — ${errors.length} information requirement violation(s)`,
                errors.map((f) => ({
                    requirementId: f.requirementId,
                    severity: "error" as const,
                    entityGuid: f.entityGuid,
                    ifcClass: f.entityType,
                    message: f.message,
                    details: { source: f.source, runUuid: requirements.runUuid },
                })),
                requirements.profile?.familyKey ?? "project-profile-v1"
            );
        }

        /* -------- 6. pure GlobalId preflight (ADR-0051 §2): the lossless
                       occurrence contract, malformed GlobalIds and duplicate exact
                       GlobalIds are validated BEFORE saveInventorySnapshot, so no
                       `entities`/`spaces`/`bindings`/asset row is ever written for a
                       duplicate. The write path keeps the same checks as defence in
                       depth, but is no longer the first detector. -------- */
        stage = "space_globalid_preflight";
        const { occurrences } = preflightSpaceOccurrences({
            extracted, modelVersionId: versionId, linkedModelId: linkedParentId,
        });

        /* -------- 7. inventário de entities (snapshot da versão) -------- */
        stage = "inventory";
        const { spaceEntityIdsByGuid, elementEntityIdsByGuid } =
            await inventoryDb.saveInventorySnapshot(versionId, inventoryData);

        /* -------- 8–11. identidade persistente, ativos, materialização e
                          ativação correm sob um LOCK cooperativo com âmbito no
                          linked_model (ADR-0052 §8). O lock é adquirido ANTES de
                          qualquer mutação de metadados do espaço (inventory_code de
                          IfcSpace.Name + long_name de IfcSpace.LongName) e mantido até
                          a compensação de metadados terminar, pelo que, durante esta
                          janela, nenhuma operação cooperante do MESMO linked_model pode
                          reclamar o código de inventário anterior. Uploads de
                          linked_models DIFERENTES usam nomes de lock distintos e
                          permanecem independentes. -------- */
        // Non-null captures for the closure (both are guaranteed set by this point):
        // the model was reused/created above and the version was reserved.
        const activeModelId: number = modelId!;
        const activeVersionId: number = versionId!;
        const runIdentityAndActivation = async (): Promise<{ presentNormalizedCodes: string[] }> => {
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
                    modelId: activeModelId,
                    modelVersionId: activeVersionId,
                    candidates,
                    // Lossless occurrences so a duplicate exact GlobalId is detected and
                    // blocks BEFORE any persistent write (§1); candidates alone are
                    // GlobalId-collapsed and cannot reveal it.
                    occurrences,
                });

                createdSpaceIds = spatial.createdSpaceIds;
                metadataUpdates = spatial.metadataUpdates;
                presentNormalizedCodes = spatial.presentNormalizedCodes;
                spaceInfoByGuid = spatial.spaceInfoByGuid;
            }

            /* -------- ativos persistentes: reconciliação de identidade,
                        política de reservabilidade e bindings (Prompt 4) -------- */
            stage = "asset_reconciliation";
            if (linkedParentId !== null) {
                const assetOutcome = await persistAssetsForVersion({
                    linkedModelId: linkedParentId,
                    modelId: activeModelId,
                    modelVersionId: activeVersionId,
                    inventoryData,
                    spaceEntityIdsByGuid,
                    elementEntityIdsByGuid,
                    spaceInfoByGuid,
                });
                createdAssetIds = assetOutcome.createdAssetIds;
            }

            /* -------- materialização semântica controlada (Prompt 7D) -------- */
            if (input.controlledIntake) {
                stage = "semantic_materialisation";
                const intakeConfig = loadModelIntakeConfig();
                try {
                    semanticMaterialisation = await new SemanticMaterialisationService().materialise({
                        versionId: activeVersionId,
                        extractedModel: extracted,
                        ids: input.controlledIntake.idsProfile,
                        context: input.controlledIntake.semanticContext,
                    });
                } catch (error) {
                    if (intakeConfig.mode === "required") throw error;
                    semanticMaterialisation = {
                        status: "failed_retryable",
                        message: "Semantic materialisation failed; IFC version continued in best_effort mode.",
                    };
                }
            }

            /* -------- ativação e troca da versão corrente -------- */
            stage = "activation";
            await versionDb.activateVersion(activeModelId, activeVersionId);

            /* -------- reconciliação pós-ativação: estados dos espaços e
                        ciclo de vida dos ativos (nunca apaga) -------- */
            if (linkedParentId !== null) {
                await reconcileSpaceStatusesAfterActivation({
                    linkedModelId: linkedParentId,
                    modelId: activeModelId,
                    presentNormalizedCodes,
                });
            }
            await reconcileAssetLifecycleAfterActivation({
                modelId: activeModelId,
                currentVersionId: activeVersionId,
            });
            return { presentNormalizedCodes };
        };

        if (linkedParentId !== null) {
            // linked_model-scoped cooperative lock (§6). Held across persistence,
            // activation AND the Reference compensation below. `activationSucceeded` is
            // set INSIDE the callback so that a lock-WRAPPER failure occurring AFTER the
            // callback (e.g. a RELEASE_LOCK/connection-cleanup failure, §5-v3) is not
            // mistaken for a business failure that must roll back a committed activation.
            let activationSucceeded = false;
            try {
                await spaceDb.withSpaceMetadataLock(linkedParentId, async () => {
                    try {
                        await runIdentityAndActivation();
                        activationSucceeded = true;
                    } catch (rawError: any) {
                        // Normalize non-Error throwables before attaching metadata (§5.5).
                        const error = rawError instanceof Error ? rawError : new Error(String(rawError));
                        // §8: restore the failed operation's space-metadata projection
                        // while the lock is STILL held, so no cooperating same-linked_model
                        // operation can claim the previous inventory code during this window.
                        const notes = await restoreSpaceMetadataProjections(
                            [...metadataUpdates, ...((rawError && rawError.metadataUpdates) ?? [])], { modelId, versionId });
                        if (notes.length) (error as any).compensationIntegrity = notes;
                        // Restoration is complete; the remaining orphan-row/file cleanup does
                        // not touch the metadata projection and runs outside the lock.
                        (error as any).metadataUpdates = [];
                        metadataUpdates = [];
                        throw error;
                    }
                });
            } catch (lockError: any) {
                if (activationSucceeded) {
                    // §5-v3 case C: the callback (persistence + activation) COMMITTED, but
                    // the lock wrapper failed afterwards (RELEASE_LOCK/cleanup). The named
                    // lock was already force-freed by destroying the session in
                    // withNamedLock. Do NOT enter the business-compensation path (it would
                    // wrongly roll back a committed activation and assume a Reference
                    // restore that never happened). Surface a precise operational warning
                    // and continue as success.
                    logUploadFailure("lock_release_after_activation", lockError,
                        { modelId, versionId, note: "activation committed; named lock force-freed via session close; no business compensation" });
                } else {
                    // Acquisition failure or callback failure → outer compensation.
                    throw lockError;
                }
            }
        } else {
            // No linked_model → no persistent-space Reference projection → no lock.
            await runIdentityAndActivation();
        }

        return {
            modelId,
            linkedParentId,
            versionId,
            versionNumber: reserved.versionNumber,
            fileHash,
            fileSize,
            isNewModel,
            versionUuid: reserved.versionUuid,
            previousCurrentVersionId,
            semanticMaterialisation,
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
            // Inventory-code/LongName changes (from IfcSpace.Name/LongName) applied to
            // REUSED (pre-existing) spaces are restored INSIDE the linked_model
            // space-metadata lock (§6), before this outer compensation runs — so the
            // previous inventory code cannot be reclaimed by a cooperating
            // same-linked_model operation during the restore window.
            // Any restore anomaly is carried on error.compensationIntegrity and folded
            // into the recorded failure reason below (§6.7).
            try { await inventoryDb.deleteInventoryForVersion(versionId); } catch (e) {
                logUploadFailure("compensation_inventory", e, { modelId, versionId });
            }
            try {
                const failedStage = error?.uploadStage ?? stage;
                const reason = error?.failureReason ?? error?.message ?? String(error);
                const compNote = Array.isArray(error?.compensationIntegrity) && error.compensationIntegrity.length
                    ? ` | compensation_integrity: ${error.compensationIntegrity.join("; ")}`
                    : "";
                await versionDb.markFailed(versionId, `${failedStage}: ${reason}${compNote}`);
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
