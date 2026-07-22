import express from "express";
import assetDb from "../utils/assetDatabase.ts";
import persistentAssetDb from "../utils/persistentAssetDatabase.ts";
import nonModelledDb from "../utils/nonModelledAssetDatabase.ts";
import registrationService from "../services/nonModelledAssetRegistrationService.ts";
import locationService from "../services/nonModelledAssetLocationService.ts";
import { NonModelledAssetError } from "../services/nonModelledAssetTypes.ts";
import { getReservabilityEvaluator } from "../policies/policyProvider.ts";
import { buildSuccessResponse, buildErrorResponse } from "../utils/responseHandler.ts";
import { logConcurrencyEvent } from "../utils/concurrencyControl.ts";
import { ApplicationIdentityDatabase } from "../applicationIdentity/applicationIdentityDatabase.ts";

/** Erros tipados 5B → HTTP; restantes → 500 sem stack trace. */
function nonModelledErrorResponse(res: any, error: any) {
  if (error instanceof NonModelledAssetError) {
    return buildErrorResponse(res, error.statusCode, error.message);
  }
  return buildErrorResponse(res, 500, error?.message ?? "Unexpected error");
}

const app = express();
app.use(express.json());

async function requireStudent(req: express.Request, res: express.Response) {
  if (!req.applicationIdentity) {
    buildErrorResponse(res, 401, "A local development session is required.");
    return false;
  }
  const area = await new ApplicationIdentityDatabase().applicationArea(Number(req.applicationIdentity.accountId));
  if (area !== "student") {
    buildErrorResponse(res, 403, "This resource list is available only to the student reservation workspace.");
    return false;
  }
  return true;
}

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

app.get("/availability/persistent/:persistentAssetId", async (req, res) => {
  const { persistentAssetId } = req.params;
  const { start, end } = req.query;
  if (!await requireStudent(req, res)) return;
  if (!start || !end) return buildErrorResponse(res, 400, "Missing start or end query parameters");
  const startDate = new Date(String(start));
  const endDate = new Date(String(end));
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return buildErrorResponse(res, 400, "Invalid start or end date");
  if (endDate <= startDate) return buildErrorResponse(res, 400, "End time must be after start time");
  if (startDate <= new Date()) return buildErrorResponse(res, 400, "Cannot create reservation in the past");
  try {
    const assetId = await persistentAssetDb.resolveReservableAssetId(persistentAssetId);
    if (!assetId) return buildErrorResponse(res, 404, "Reservable asset not found");
    return buildSuccessResponse(res, 200, await assetDb.getAvailability(assetId, startDate, endDate));
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

/* Global student catalogue: one query, optional logical model line filter. */
app.get("/persistent/reservable", async (req, res) => {
  try {
    if (!await requireStudent(req, res)) return;
    const raw = req.query.modelLineId;
    const modelLineId = raw == null || raw === "" ? null : Number(raw);
    if (modelLineId !== null && (!Number.isInteger(modelLineId) || modelLineId <= 0)) {
      return buildErrorResponse(res, 400, "Valid model line ID is required");
    }
    return buildSuccessResponse(res, 200, {
      items: await nonModelledDb.listStudentReservableAssets(modelLineId),
    });
  } catch (error: any) {
    return buildErrorResponse(res, 500, error.message);
  }
});

/* Resolves a visible IFC element only through its binding in the current version. */
app.get("/persistent/current-binding/:modelLineId/:guid", async (req, res) => {
  try {
    if (!await requireStudent(req, res)) return;
    const modelLineId = Number(req.params.modelLineId);
    if (!Number.isInteger(modelLineId) || modelLineId <= 0 || !req.params.guid) {
      return buildErrorResponse(res, 400, "Valid model line ID and IFC GUID are required");
    }
    const item = await persistentAssetDb.getStudentAssetByCurrentBinding(modelLineId, req.params.guid);
    if (!item) return buildErrorResponse(res, 404, "The selected IFC element is not a current reservable persistent asset.");
    return buildSuccessResponse(res, 200, item);
  } catch (error: any) {
    return buildErrorResponse(res, 500, error.message);
  }
});

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

    // (Prompt 6, §7) Preparação FORA da transação (validações de input e
    // avaliação do provider de política — não prolongam a posse do lock);
    // efeitos e marcação acontecem numa transação única com FOR UPDATE na
    // linha do caso, em resolveCaseTransactionally. Uma resolução simultânea
    // do MESMO caso perde a corrida e recebe 409 — casos resolvidos nunca
    // são alterados.
    let caseStatus = "";
    let linkAssetId: number | null = null;
    let newAsset: { name: string; reservable: boolean } | null = null;
    let retireAssetId: number | null = null;

    if (resolution === "ignore_non_asset") {
      caseStatus = "ignored";

    } else if (resolution === "link_to_existing_asset") {
      if (!Number.isInteger(Number(assetId))) {
        return buildErrorResponse(res, 400, "assetId is required for link_to_existing_asset");
      }
      linkAssetId = Number(assetId);
      caseStatus = "resolved_link";

    } else {
      // confirm_as_new_asset / confirm_replacement: criar novo ativo,
      // avaliando a reservabilidade pelo provider configurado
      if (resolution === "confirm_replacement" && !Number.isInteger(Number(assetId))) {
        return buildErrorResponse(res, 400, "assetId (ativo substituído) is required for confirm_replacement");
      }

      const decision = await getReservabilityEvaluator().evaluate(
        { guid: reconciliationCase.ifc_guid, name: reconciliationCase.name_snapshot,
          ifcType: reconciliationCase.type_snapshot, entityType: "element" },
        { modelVersionId: reconciliationCase.model_version_id }
      );

      newAsset = {
        name: reconciliationCase.name_snapshot ?? reconciliationCase.ifc_guid,
        reservable: decision.decision === "allow",
      };
      caseStatus = resolution === "confirm_replacement" ? "resolved_replacement" : "resolved_new";
      if (resolution === "confirm_replacement") {
        retireAssetId = Number(assetId);
      }
    }

    const outcome = await persistentAssetDb.resolveCaseTransactionally({
      caseId,
      caseStatus,
      resolvedBy: resolvedBy ?? null,
      linkAssetId,
      newAsset,
      retireAssetId,
      skipBinding: resolution === "ignore_non_asset",
    });

    if (outcome.alreadyResolvedAs) {
      logConcurrencyEvent("reconciliation_conflict", { caseId, alreadyResolvedAs: outcome.alreadyResolvedAs });
      return buildErrorResponse(res, 409, `Case ${caseId} is already ${outcome.alreadyResolvedAs}`);
    }

    return buildSuccessResponse(res, 200, {
      caseId, status: caseStatus, resolvedAssetId: outcome.resolvedAssetId,
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
