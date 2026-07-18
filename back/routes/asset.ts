import express from "express";
import assetDb from "../utils/assetDatabase.ts";
import persistentAssetDb from "../utils/persistentAssetDatabase.ts";
import nonModelledDb from "../utils/nonModelledAssetDatabase.ts";
import registrationService from "../services/nonModelledAssetRegistrationService.ts";
import locationService from "../services/nonModelledAssetLocationService.ts";
import { NonModelledAssetError } from "../services/nonModelledAssetTypes.ts";
import { getReservabilityEvaluator } from "../policies/policyProvider.ts";
import { buildSuccessResponse, buildErrorResponse } from "../utils/responseHandler.ts";

/** Erros tipados 5B → HTTP; restantes → 500 sem stack trace. */
function nonModelledErrorResponse(res: any, error: any) {
  if (error instanceof NonModelledAssetError) {
    return buildErrorResponse(res, error.statusCode, error.message);
  }
  return buildErrorResponse(res, 500, error?.message ?? "Unexpected error");
}

const app = express();
app.use(express.json());

/* -------------------------------------
   GET asset by GUID / specific version
------------------------------------- */
app.get("/by-guid/:guid/:versionId", async (req, res) => {
  const { guid, versionId } = req.params;

  try {
    const asset = await assetDb.getAssetByGuid(
      guid,
      Number(versionId)
    );

    return buildSuccessResponse(res, 200, asset);

  } catch (error: any) {
    return buildErrorResponse(res, 500, error.message);
  }
});


/* -------------------------------------
   GET availability (version aware)
------------------------------------- */
app.get("/availability/:assetId", async (req, res) => {
  const { assetId } = req.params;
  const { start, end } = req.query;

  if (!start || !end) {
    return buildErrorResponse(res, 400, "Missing start or end query parameters");
  }

  const startDate = new Date(start as string);
  const endDate = new Date(end as string);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return buildErrorResponse(res, 400, "Invalid start or end date");
  }

  // Mesmas regras da criação de reserva: período inválido e início no passado
  // são avisados já na verificação de disponibilidade, não apenas ao solicitar
  if (endDate <= startDate) {
    return buildErrorResponse(res, 400, "End time must be after start time");
  }

  if (startDate <= new Date()) {
    return buildErrorResponse(res, 400, "Cannot create reservation in the past");
  }

  try {
    const result = await assetDb.getAvailability(
      Number(assetId),
      startDate,
      endDate
    );

    return buildSuccessResponse(res, 200, result);

  } catch (error: any) {
    return buildErrorResponse(res, 500, error.message);
  }
});



/* -------------------------------------
   GET assets by space / specific version
------------------------------------- */
app.get("/by-space/:spaceEntityId/:versionId", async (req, res) => {
  const { spaceEntityId, versionId } = req.params;

  try {
    const assets = await assetDb.getAssetsBySpace(
      Number(spaceEntityId),
      Number(versionId)
    );

    return buildSuccessResponse(res, 200, assets);
  } catch (error: any) {
    return buildErrorResponse(res, 500, error.message);
  }
});

/* -------------------------------------
   GET all assets / specific version
------------------------------------- */
app.get("/by-model/:modelId/:versionId", async (req, res) => {
  const { modelId, versionId } = req.params;

  try {
    const assets = await assetDb.getAssetsByModel(
      Number(modelId),
      Number(versionId)
    );

    return buildSuccessResponse(res, 200, assets);
  } catch (error: any) {
    return buildErrorResponse(res, 500, error.message);
  }
});

/* -------------------------------------
   GET asset by GUID - LATEST VERSION
------------------------------------- */
app.get("/by-guid-latest/:modelId/:guid", async (req, res) => {
  const { modelId, guid } = req.params;

  try {
    const asset = await assetDb.getAssetByGuidLatest(
      Number(modelId),
      guid
    );

    return buildSuccessResponse(res, 200, asset);

  } catch (error: any) {
    return buildErrorResponse(res, 500, error.message);
  }
});

/* -------------------------------------
   (Prompt 4) Ativo persistente, bindings e reconciliação
------------------------------------- */

/* Ativo persistente (identidade + ciclo de vida + projeção) */
app.get("/persistent/:assetId", async (req, res) => {
  const assetId = Number(req.params.assetId);

  if (!Number.isInteger(assetId) || assetId <= 0) {
    return buildErrorResponse(res, 400, "Valid asset ID is required");
  }

  try {
    const asset = await persistentAssetDb.getPersistentAsset(assetId);

    if (!asset) {
      return buildErrorResponse(res, 404, `Asset ${assetId} not found`);
    }

    return buildSuccessResponse(res, 200, asset);
  } catch (error: any) {
    return buildErrorResponse(res, 500, error.message);
  }
});

/* Histórico de representação de um ativo (bindings por versão) */
app.get("/:assetId/bindings", async (req, res) => {
  const assetId = Number(req.params.assetId);

  if (!Number.isInteger(assetId) || assetId <= 0) {
    return buildErrorResponse(res, 400, "Valid asset ID is required");
  }

  try {
    const bindings = await persistentAssetDb.getBindingsByAsset(assetId);
    return buildSuccessResponse(res, 200, bindings);
  } catch (error: any) {
    return buildErrorResponse(res, 500, error.message);
  }
});

/* Bindings de uma versão explícita */
app.get("/version/:versionId/bindings", async (req, res) => {
  const versionId = Number(req.params.versionId);

  if (!Number.isInteger(versionId) || versionId <= 0) {
    return buildErrorResponse(res, 400, "Valid version ID is required");
  }

  try {
    const bindings = await persistentAssetDb.getBindingsByVersion(versionId);
    return buildSuccessResponse(res, 200, bindings);
  } catch (error: any) {
    return buildErrorResponse(res, 500, error.message);
  }
});

/* Casos de reconciliação (?status=open por omissão; ?status=all para todos) */
app.get("/reconciliation/cases", async (req, res) => {
  try {
    const status = (req.query.status as string) ?? "open";
    const cases = await persistentAssetDb.listReconciliationCases(status === "all" ? undefined : status);
    return buildSuccessResponse(res, 200, cases);
  } catch (error: any) {
    return buildErrorResponse(res, 500, error.message);
  }
});

/* Resolução administrativa de um caso (mecanismo atual: a aplicação não tem
   autenticação — ver documentação; uso via Bruno/curl) */
app.post("/reconciliation/cases/:caseId/resolve", async (req, res) => {
  const caseId = Number(req.params.caseId);
  const { resolution, assetId, resolvedBy } = req.body ?? {};

  if (!Number.isInteger(caseId) || caseId <= 0) {
    return buildErrorResponse(res, 400, "Valid case ID is required");
  }

  const valid = ["link_to_existing_asset", "confirm_as_new_asset", "confirm_replacement", "ignore_non_asset"];
  if (!valid.includes(resolution)) {
    return buildErrorResponse(res, 400, `resolution must be one of: ${valid.join(", ")}`);
  }

  try {
    const reconciliationCase = await persistentAssetDb.getReconciliationCase(caseId);

    if (!reconciliationCase) {
      return buildErrorResponse(res, 404, `Case ${caseId} not found`);
    }
    if (reconciliationCase.status !== "open") {
      return buildErrorResponse(res, 409, `Case ${caseId} is already ${reconciliationCase.status}`);
    }

    let resolvedAssetId: number | null = null;
    let caseStatus = "";

    if (resolution === "ignore_non_asset") {
      caseStatus = "ignored";

    } else if (resolution === "link_to_existing_asset") {
      if (!Number.isInteger(Number(assetId))) {
        return buildErrorResponse(res, 400, "assetId is required for link_to_existing_asset");
      }
      resolvedAssetId = Number(assetId);
      caseStatus = "resolved_link";

    } else {
      // confirm_as_new_asset / confirm_replacement: criar novo ativo,
      // avaliando a reservabilidade pelo provider configurado
      const decision = await getReservabilityEvaluator().evaluate(
        { guid: reconciliationCase.ifc_guid, name: reconciliationCase.name_snapshot,
          ifcType: reconciliationCase.type_snapshot, entityType: "element" },
        { modelVersionId: reconciliationCase.model_version_id }
      );

      const created = await persistentAssetDb.createAsset({
        name: reconciliationCase.name_snapshot ?? reconciliationCase.ifc_guid,
        assetType: "equipment",
        linkedModelId: null,
        reservable: decision.decision === "allow",
      });
      resolvedAssetId = created.assetId;
      caseStatus = resolution === "confirm_replacement" ? "resolved_replacement" : "resolved_new";

      if (resolution === "confirm_replacement") {
        // decisão HUMANA explícita: o ativo substituído é retirado
        if (!Number.isInteger(Number(assetId))) {
          return buildErrorResponse(res, 400, "assetId (ativo substituído) is required for confirm_replacement");
        }
        await persistentAssetDb.retireAsset(Number(assetId));
      }
    }

    if (resolvedAssetId !== null) {
      await persistentAssetDb.createBinding({
        assetId: resolvedAssetId,
        modelVersionId: reconciliationCase.model_version_id,
        modelEntityId: reconciliationCase.model_entity_id,
        spaceId: reconciliationCase.space_id ?? null,
        ifcGuid: reconciliationCase.ifc_guid,
        nameSnapshot: reconciliationCase.name_snapshot ?? null,
        typeSnapshot: reconciliationCase.type_snapshot ?? null,
        reconciliationMethod: resolution,
        reconciliationConfidence: "manual",
      });
    }

    await persistentAssetDb.markCaseResolved(caseId, caseStatus, resolvedAssetId, resolvedBy ?? null);

    return buildSuccessResponse(res, 200, {
      caseId, status: caseStatus, resolvedAssetId,
      message: `Reconciliation case resolved as ${resolution}`,
    });
  } catch (error: any) {
    return buildErrorResponse(res, 500, error.message);
  }
});

/* -------------------------------------
   (Prompt 5B) Ativos NÃO modelados — grafo como autoridade, SQL como projeção.
   Endpoints ADMINISTRATIVOS: a aplicação não tem autenticação (limitação
   documentada — uso via Bruno/curl, como os endpoints de reconciliação do P4).
------------------------------------- */

/* Registo (idempotente via registrationKey no payload) */
app.post("/non-modelled", async (req, res) => {
  try {
    const result = await registrationService.register(req.body ?? {});
    return buildSuccessResponse(res, 201, result);
  } catch (error: any) {
    return nonModelledErrorResponse(res, error);
  }
});

/* Consulta da projeção (asset + localização corrente + estado) */
app.get("/non-modelled/:assetId", async (req, res) => {
  const assetId = Number(req.params.assetId);
  if (!Number.isInteger(assetId) || assetId <= 0) {
    return buildErrorResponse(res, 400, "Valid asset ID is required");
  }

  try {
    const asset = await nonModelledDb.findAssetById(assetId);
    if (!asset || asset.source !== "graph") {
      return buildErrorResponse(res, 404, `Non-modelled asset ${assetId} not found`);
    }
    const current = await nonModelledDb.getCurrentAssignment(assetId);
    return buildSuccessResponse(res, 200, {
      ...asset,
      locationStatus: current ? (current.space_status === "active" ? "located" : "location_unavailable") : "pending_location",
      currentLocation: current,
    });
  } catch (error: any) {
    return nonModelledErrorResponse(res, error);
  }
});

/* Estado da projeção/sincronização */
app.get("/non-modelled/:assetId/projection-status", async (req, res) => {
  const assetId = Number(req.params.assetId);
  if (!Number.isInteger(assetId) || assetId <= 0) {
    return buildErrorResponse(res, 400, "Valid asset ID is required");
  }

  try {
    const asset = await nonModelledDb.findAssetById(assetId);
    if (!asset || asset.source !== "graph") {
      return buildErrorResponse(res, 404, `Non-modelled asset ${assetId} not found`);
    }
    const current = await nonModelledDb.getCurrentAssignment(assetId);
    const pendingOps = await nonModelledDb.countIncompleteOperationsForAsset(asset.asset_uuid);
    return buildSuccessResponse(res, 200, {
      assetId,
      assetUuid: asset.asset_uuid,
      semanticUri: asset.semantic_uri,
      lifecycleStatus: asset.lifecycle_status,
      reservable: Boolean(asset.reservable),
      locationStatus: current ? (current.space_status === "active" ? "located" : "location_unavailable") : "pending_location",
      incompleteSyncOperations: pendingOps,
      reservableNow: Boolean(asset.reservable) && asset.lifecycle_status === "active"
        && current !== null && current.space_status === "active" && pendingOps === 0,
    });
  } catch (error: any) {
    return nonModelledErrorResponse(res, error);
  }
});

/* Movimento (idempotente via movementKey; só source manual nesta etapa) */
app.post("/non-modelled/:assetId/location", async (req, res) => {
  const assetId = Number(req.params.assetId);
  if (!Number.isInteger(assetId) || assetId <= 0) {
    return buildErrorResponse(res, 400, "Valid asset ID is required");
  }

  try {
    const result = await locationService.move({
      movementKey: req.body?.movementKey,
      assetId,
      newSpaceId: req.body?.newSpaceId,
      source: req.body?.source,
    });
    return buildSuccessResponse(res, 200, result);
  } catch (error: any) {
    return nonModelledErrorResponse(res, error);
  }
});

/* Histórico de localização (projeção SQL; nunca sobrescrito) */
app.get("/non-modelled/:assetId/location-history", async (req, res) => {
  const assetId = Number(req.params.assetId);
  if (!Number.isInteger(assetId) || assetId <= 0) {
    return buildErrorResponse(res, 400, "Valid asset ID is required");
  }

  try {
    const asset = await nonModelledDb.findAssetById(assetId);
    if (!asset || asset.source !== "graph") {
      return buildErrorResponse(res, 404, `Non-modelled asset ${assetId} not found`);
    }
    const history = await nonModelledDb.getLocationHistory(assetId);
    return buildSuccessResponse(res, 200, history);
  } catch (error: any) {
    return nonModelledErrorResponse(res, error);
  }
});

/* -------------------------------------
   GET specific asset / specific version
------------------------------------- */
app.get("/:assetId/:versionId", async (req, res) => {
  const { assetId, versionId } = req.params;

  try {
    const asset = await assetDb.getAssetById(
      Number(assetId),
      Number(versionId)
    );

    return buildSuccessResponse(res, 200, asset);
  } catch (error: any) {
    return buildErrorResponse(res, 500, error.message);
  }
});





export default app;
