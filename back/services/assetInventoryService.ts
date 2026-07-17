import assetDb from "../utils/persistentAssetDatabase.ts";
import { getAssetIdentityResolver } from "../identity/assetIdentityProvider.ts";
import { getEquipmentClassifier } from "../classification/equipmentClassifierProvider.ts";
import { getReservabilityEvaluator } from "../policies/policyProvider.ts";

/**
 * Inventário persistente de ativos (Prompt 4) — substitui a criação legada de
 * ativos por versão.
 *
 * Quatro responsabilidades mantidas separadas:
 *  - identidade (AssetIdentityResolver / spaces.space_id);
 *  - binding (asset_bindings por versão);
 *  - localização (asset_bindings.space_id);
 *  - reservabilidade (provider de política; projeção assets.reservable).
 *
 * Regras:
 *  - ativo-espaço: spaces.id → assets.space_id (1:1); mesma identidade em
 *    todas as versões; espaço sem identidade persistente NÃO gera ativo novo;
 *  - equipamento: identidade por código estável > serial > GUID na linha de
 *    modelo > primeira versão; sem evidência em versão posterior → caso de
 *    reconciliação (SEM asset/binding: não reservável, não contorna reservas;
 *    a geometria continua visível no viewer, o inventário fica incompleto e
 *    sinalizado);
 *  - política: allow → reservável; deny em candidato NOVO → comportamento
 *    legado (sem ativo — caso IfcSensor); deny/undetermined/error em ativo
 *    EXISTENTE → apenas projeção reservable=0 (identidade/bindings/reservas
 *    intocados; estratégia defensiva documentada, sem comportamento inventado).
 */

export interface AssetInventoryInput {
    linkedModelId: number;
    modelId: number;
    modelVersionId: number;
    inventoryData: Record<string, any>;
    spaceEntityIdsByGuid: Record<string, number>;
    elementEntityIdsByGuid: Record<string, number>;
    /** guid do espaço → identidade persistente (do spaceIdentityService). */
    spaceInfoByGuid: Record<string, { spaceId: number; code: string }>;
}

export interface AssetInventoryOutcome {
    createdAssetIds: number[];
    bindingsCreated: number;
    casesCreated: number;
    diagnostics: {
        spaces_without_identity: string[];
        equipment_pending_reconciliation: string[];
        policy_denied_new: string[];
        policy_not_allow_existing: { guid: string; decision: string }[];
        /** Classes fora do perfil: entity preservada, SEM ativo — nunca silenciosamente ignorado. */
        undetermined_classification: { guid: string; ifcClass: string }[];
        /** Elementos arquitetónicos/estruturais/ignorados (entity apenas). */
        non_equipment_elements: { guid: string; ifcClass: string; classification: string }[];
    };
}

function logAssets(event: string, payload: Record<string, unknown>) {
    console.log(JSON.stringify({ type: "asset_inventory", event, at: new Date().toISOString(), ...payload }));
}

export class AssetStageError extends Error {
    readonly uploadStage: string;
    readonly createdAssetIds: number[];
    constructor(stage: string, message: string, createdAssetIds: number[]) {
        super(message);
        this.name = "AssetStageError";
        this.uploadStage = stage;
        this.createdAssetIds = createdAssetIds;
    }
}

export async function persistAssetsForVersion(input: AssetInventoryInput): Promise<AssetInventoryOutcome> {
    const identityResolver = getAssetIdentityResolver();
    const reservability = getReservabilityEvaluator();

    const outcome: AssetInventoryOutcome = {
        createdAssetIds: [],
        bindingsCreated: 0,
        casesCreated: 0,
        diagnostics: {
            spaces_without_identity: [],
            equipment_pending_reconciliation: [],
            policy_denied_new: [],
            policy_not_allow_existing: [],
            undetermined_classification: [],
            non_equipment_elements: [],
        },
    };

    let stage = "asset_reconciliation";

    try {
        /* ================= ATIVOS-ESPAÇO ================= */
        for (const [guid, space] of Object.entries(input.inventoryData)) {
            const entityId = input.spaceEntityIdsByGuid[guid];
            if (entityId === undefined) continue;

            const info = input.spaceInfoByGuid[guid];

            if (!info) {
                // Espaço sem identidade persistente: no fluxo estrito atual não
                // gera ativo de espaço (regra do Prompt 4 §6 — substitui o
                // comportamento legado de asset por versão).
                outcome.diagnostics.spaces_without_identity.push(guid);
                continue;
            }

            stage = "asset_policy";
            const decision = await reservability.evaluate(
                { guid, name: space.spaceName, ifcType: "IfcSpace", entityType: "space" },
                { modelVersionId: input.modelVersionId }
            );

            stage = "asset_reconciliation";
            let asset = await assetDb.findSpaceAsset(info.spaceId);

            if (!asset && decision.decision === "allow") {
                const created = await assetDb.createAsset({
                    name: space.spaceLongName ?? space.spaceName ?? info.code,
                    assetType: "space",
                    assetCode: info.code,
                    spaceId: info.spaceId,
                    linkedModelId: input.linkedModelId,
                    reservable: true,
                });
                asset = { id: created.assetId };
                outcome.createdAssetIds.push(created.assetId);
            } else if (asset) {
                await assetDb.updateAssetProjection(asset.id, {
                    name: space.spaceLongName ?? space.spaceName ?? null,
                    reservable: decision.decision === "allow" ? true : false,
                });
                if (decision.decision !== "allow") {
                    outcome.diagnostics.policy_not_allow_existing.push({ guid, decision: decision.decision });
                }
            }

            if (asset) {
                stage = "asset_binding";
                await assetDb.createBinding({
                    assetId: asset.id,
                    modelVersionId: input.modelVersionId,
                    modelEntityId: entityId,
                    spaceId: info.spaceId,
                    ifcGuid: guid,
                    assetCodeSnapshot: info.code,
                    nameSnapshot: space.spaceName ?? null,
                    typeSnapshot: "IfcSpace",
                    reconciliationMethod: "space_id",
                    reconciliationConfidence: "high",
                });
                outcome.bindingsCreated++;
                stage = "asset_reconciliation";
            }
        }

        /* ================= EQUIPAMENTOS ================= */
        const classifier = getEquipmentClassifier();

        for (const [spaceGuid, space] of Object.entries(input.inventoryData)) {
            const spaceInfo = input.spaceInfoByGuid[spaceGuid] ?? null;
            const spaceEntityId = input.spaceEntityIdsByGuid[spaceGuid] ?? null;

            for (const element of (space.elements ?? [])) {
                const entityId = input.elementEntityIdsByGuid[element.guid];
                if (entityId === undefined) continue;

                stage = "asset_reconciliation";

                /* ---- classificação de domínio (central; nunca a política) ---- */
                const classification = classifier.classify(
                    { guid: element.guid, ifcClass: element.type, name: element.name ?? null,
                      predefinedType: element.predefinedType ?? null,
                      objectType: element.objectType ?? null, tag: element.tag ?? null,
                      psets: element.psets ?? null },
                    { modelId: input.modelId, modelVersionId: input.modelVersionId, linkedModelId: input.linkedModelId }
                );

                if (classification.classification !== "managed_equipment") {
                    // Entity preservada; sem ativo. 'undetermined' fica em
                    // diagnóstico explícito (decisão humana/extensão do perfil);
                    // 'invalid_proxy' é inalcançável (o preflight rejeita antes).
                    if (classification.classification === "undetermined") {
                        outcome.diagnostics.undetermined_classification.push({ guid: element.guid, ifcClass: element.type });
                    } else {
                        outcome.diagnostics.non_equipment_elements.push({
                            guid: element.guid, ifcClass: element.type, classification: classification.classification,
                        });
                    }
                    continue;
                }

                const identity = await identityResolver.resolve(
                    { guid: element.guid, name: element.name, ifcType: element.type,
                      tag: element.tag ?? null, objectType: element.objectType ?? null,
                      psets: element.psets ?? null, entityId, spaceId: spaceInfo?.spaceId ?? null },
                    { linkedModelId: input.linkedModelId, modelId: input.modelId, modelVersionId: input.modelVersionId }
                );

                if (identity.status === "ambiguous" || identity.status === "unresolved") {
                    await assetDb.createReconciliationCase({
                        modelVersionId: input.modelVersionId,
                        modelEntityId: entityId,
                        ifcGuid: element.guid,
                        nameSnapshot: element.name ?? null,
                        typeSnapshot: element.type ?? null,
                        spaceId: spaceInfo?.spaceId ?? null,
                        candidates: identity.candidatesConsidered,
                    });
                    outcome.casesCreated++;
                    outcome.diagnostics.equipment_pending_reconciliation.push(element.guid);
                    continue;
                }

                stage = "asset_policy";
                const decision = await reservability.evaluate(
                    { guid: element.guid, name: element.name, ifcType: element.type, entityType: "element" },
                    { modelVersionId: input.modelVersionId }
                );

                stage = "asset_reconciliation";
                let assetId: number | null = null;

                if (identity.status === "matched") {
                    assetId = identity.matchedAssetId!;
                    await assetDb.updateAssetProjection(assetId, {
                        name: element.name ?? null,
                        reservable: decision.decision === "allow",
                    });
                    // enriquecimento de evidência: serial só quando ausente
                    // (serial divergente teria dado caso de reconciliação)
                    if (identity.serialNumber) {
                        await assetDb.setAssetSerialIfMissing(assetId, identity.serialNumber);
                    }
                    if (decision.decision !== "allow") {
                        outcome.diagnostics.policy_not_allow_existing.push({ guid: element.guid, decision: decision.decision });
                    }
                } else {
                    // identity.status === "new"
                    if (decision.decision !== "allow") {
                        // comportamento legado para novos candidatos não
                        // reserváveis (ex.: IfcSensor) — sem ativo
                        outcome.diagnostics.policy_denied_new.push(element.guid);
                        continue;
                    }
                    const created = await assetDb.createAsset({
                        name: element.name ?? element.guid,
                        assetType: "equipment",
                        assetCode: identity.stableCode,
                        serialNumber: identity.serialNumber,
                        linkedModelId: input.linkedModelId,
                        reservable: true,
                    });
                    assetId = created.assetId;
                    outcome.createdAssetIds.push(created.assetId);
                }

                stage = "asset_binding";
                await assetDb.createBinding({
                    assetId,
                    modelVersionId: input.modelVersionId,
                    modelEntityId: entityId,
                    spaceId: spaceInfo?.spaceId ?? null,
                    spaceEntityId,
                    ifcGuid: element.guid,
                    assetCodeSnapshot: identity.stableCode,
                    serialSnapshot: identity.serialNumber,
                    nameSnapshot: element.name ?? null,
                    typeSnapshot: element.type ?? null,
                    // ObjectType só é relevante no perfil para IfcBuildingElementProxy
                    // (classificação do modelador); para classes IFC específicas fica
                    // NULL mesmo quando o export traga um valor — sem efeito de domínio
                    objectTypeSnapshot: element.type === "IfcBuildingElementProxy"
                        ? (element.objectType ?? null)
                        : null,
                    reconciliationMethod: identity.method,
                    reconciliationConfidence: identity.confidence,
                });
                outcome.bindingsCreated++;
            }
        }

        if (outcome.casesCreated > 0) {
            logAssets("pending_reconciliation", {
                modelVersionId: input.modelVersionId,
                cases: outcome.casesCreated,
                guids: outcome.diagnostics.equipment_pending_reconciliation,
                note: "version activates for geometry; inventory incomplete until human resolution",
            });
        }
        if (outcome.diagnostics.spaces_without_identity.length > 0) {
            logAssets("spaces_without_identity", {
                modelVersionId: input.modelVersionId,
                guids: outcome.diagnostics.spaces_without_identity,
            });
        }
        if (outcome.diagnostics.undetermined_classification.length > 0) {
            logAssets("undetermined_classification", {
                modelVersionId: input.modelVersionId,
                elements: outcome.diagnostics.undetermined_classification,
                note: "classes outside the current profile kept as entities WITHOUT assets — requires human/profile decision",
            });
        }

        return outcome;
    } catch (error: any) {
        if (error instanceof AssetStageError) throw error;
        throw new AssetStageError(stage, error?.message ?? String(error), outcome.createdAssetIds);
    }
}

/** Ciclo de vida pós-ativação (nunca apaga; retired nunca é inferido). */
export async function reconcileAssetLifecycleAfterActivation(input: {
    linkedModelId: number | null;
    modelId: number;
    currentVersionId: number;
}): Promise<void> {
    try {
        await assetDb.reconcileEquipmentLifecycle(input.modelId, input.currentVersionId);
        if (input.linkedModelId !== null) {
            await assetDb.reconcileSpaceAssetLifecycle(input.linkedModelId);
        }
    } catch (error: any) {
        logAssets("lifecycle_reconcile_failed", { error: String(error?.message ?? error) });
    }
}
