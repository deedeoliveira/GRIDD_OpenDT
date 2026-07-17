import express from "express";
import spaceDb from "../utils/spaceDatabase.ts";
import { buildSuccessResponse, buildErrorResponse } from "../utils/responseHandler.ts";

/**
 * Consulta da identidade persistente dos espaços (Prompt 3).
 * Apenas leitura — a escrita acontece exclusivamente no ciclo de upload.
 */
const app = express();

/* Espaços persistentes de uma federação (linked_model) */
app.get("/linked/:linkedModelId", async (req, res) => {
    const linkedModelId = Number(req.params.linkedModelId);

    if (!Number.isInteger(linkedModelId) || linkedModelId <= 0) {
        return buildErrorResponse(res, 400, "Valid linked model ID is required");
    }

    try {
        const spaces = await spaceDb.getSpacesByLinkedModel(linkedModelId);
        return buildSuccessResponse(res, 200, spaces);
    } catch (error: any) {
        return buildErrorResponse(res, 500, error.message);
    }
});

/* Bindings de uma versão específica (versão explícita, nunca "maior id") */
app.get("/version/:versionId/bindings", async (req, res) => {
    const versionId = Number(req.params.versionId);

    if (!Number.isInteger(versionId) || versionId <= 0) {
        return buildErrorResponse(res, 400, "Valid version ID is required");
    }

    try {
        const bindings = await spaceDb.getBindingsByVersion(versionId);
        return buildSuccessResponse(res, 200, bindings);
    } catch (error: any) {
        return buildErrorResponse(res, 500, error.message);
    }
});

/* Histórico de bindings de um espaço persistente */
app.get("/:spaceId/bindings", async (req, res) => {
    const spaceId = Number(req.params.spaceId);

    if (!Number.isInteger(spaceId) || spaceId <= 0) {
        return buildErrorResponse(res, 400, "Valid space ID is required");
    }

    try {
        const bindings = await spaceDb.getBindingsBySpace(spaceId);
        return buildSuccessResponse(res, 200, bindings);
    } catch (error: any) {
        return buildErrorResponse(res, 500, error.message);
    }
});

export default app;
