import express from "express";
import assetDb from "../utils/assetDatabase.ts";
import { buildSuccessResponse, buildErrorResponse } from "../utils/responseHandler.ts";

const app = express();
app.use(express.json());

/* -------------------------------------
   GET availability (version aware)
------------------------------------- */
app.get("/availability/:assetId/:versionId", async (req, res) => {
  const { assetId, versionId } = req.params;
  const { start, end } = req.query;

  if (!start || !end) {
    return buildErrorResponse(res, 400, "Missing start or end query parameters");
  }

  try {
    const result = await assetDb.getAvailability(
      Number(assetId),
      Number(versionId),
      new Date(start as string),
      new Date(end as string)
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
