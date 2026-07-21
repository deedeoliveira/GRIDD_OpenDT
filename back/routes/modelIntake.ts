import express from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { buildErrorResponse, buildSuccessResponse } from "../utils/responseHandler.ts";
import { ModelIntakeDatabase } from "../utils/modelIntakeDatabase.ts";
import { removeTempFile, resolveStorageKey } from "../utils/storage.ts";
import { IntakeError, ModelIntakeService } from "../modelIntake/modelIntakeService.ts";
import { getPreflightRun } from "../modelIntake/modelIntakeRunStore.ts";
import { loadModelIntakeConfig } from "../modelIntake/modelIntakeConfig.ts";

const app = express.Router();
const service = new ModelIntakeService();
const database = new ModelIntakeDatabase();
const tempRoot = path.resolve(import.meta.dirname, "../cdn_resources/models/temp");
fs.mkdirSync(tempRoot, { recursive: true });
const upload = multer({ dest: tempRoot, limits: { files: 2, fileSize: 50 * 1024 * 1024, fields: 8 } });

function files(req: express.Request): { ifcFile: Express.Multer.File | undefined; idsFile: Express.Multer.File | undefined } {
    const value = req.files as Record<string, Express.Multer.File[]> | undefined;
    return { ifcFile: value?.ifcFile?.[0], idsFile: value?.idsFile?.[0] };
}

function removeUploadedFiles(req: express.Request) {
    const selected = files(req);
    for (const file of [selected.ifcFile, selected.idsFile]) {
        if (file && fs.existsSync(file.path)) removeTempFile(file.path);
    }
}

function idsMode(value: unknown): "active" | "uploaded" {
    if (value !== "active" && value !== "uploaded") throw new IntakeError("invalid_ids_mode", "idsMode must be active or uploaded.");
    return value;
}

function modelId(value: unknown): number {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new IntakeError("invalid_model_id", "A valid modelId is required.");
    return id;
}

function safeRun(run: NonNullable<ReturnType<typeof getPreflightRun>>) {
    const { extractedModel: _extracted, rdfPreview, ...base } = run;
    return { ...base, rdfPreview: { ...rdfPreview, turtle: undefined } };
}

function failure(res: express.Response, error: any) {
    const status = error instanceof IntakeError ? error.statusCode : 500;
    return buildErrorResponse(res, status, error instanceof IntakeError ? error.message : "Controlled model intake could not be completed.");
}

app.get("/context", async (_req, res) => {
    try { return buildSuccessResponse(res, 200, await service.context()); }
    catch (error) { return failure(res, error); }
});

app.post("/preflight", upload.fields([{ name: "ifcFile", maxCount: 1 }, { name: "idsFile", maxCount: 1 }]), async (req, res) => {
    try {
        const selected = files(req);
        if (!selected.ifcFile) throw new IntakeError("ifc_file_required", "Select an IFC file.");
        const run = await service.preflight({ ifcFile: selected.ifcFile,
            ...(selected.idsFile ? { idsFile: selected.idsFile } : {}),
            idsMode: idsMode(req.body.idsMode), modelId: modelId(req.body.modelId) });
        return buildSuccessResponse(res, 200, safeRun(run));
    } catch (error) {
        removeUploadedFiles(req);
        return failure(res, error);
    }
});

app.post("/models/:modelId/versions", upload.fields([{ name: "ifcFile", maxCount: 1 }, { name: "idsFile", maxCount: 1 }]), async (req, res) => {
    try {
        const selected = files(req);
        if (!selected.ifcFile) throw new IntakeError("ifc_file_required", "Select an IFC file.");
        if (typeof req.body.preflightRunUuid !== "string" || !/^[0-9a-f-]{36}$/i.test(req.body.preflightRunUuid)) {
            throw new IntakeError("invalid_preflight_run", "A valid preflightRunUuid is required.");
        }
        const result = await service.createVersion({ preflightRunUuid: req.body.preflightRunUuid,
            ifcFile: selected.ifcFile, ...(selected.idsFile ? { idsFile: selected.idsFile } : {}), idsMode: idsMode(req.body.idsMode),
            modelId: modelId(req.params.modelId) });
        return buildSuccessResponse(res, 201, result);
    } catch (error) {
        removeUploadedFiles(req);
        return failure(res, error);
    }
});

app.get("/runs/:runUuid", (req, res) => {
    const run = getPreflightRun(req.params.runUuid);
    if (!run) return buildErrorResponse(res, 404, "Preflight run was not found or has expired.");
    return buildSuccessResponse(res, 200, safeRun(run));
});

app.get("/runs/:runUuid/turtle", (req, res) => {
    const run = getPreflightRun(req.params.runUuid);
    if (!run) return buildErrorResponse(res, 404, "Preflight run was not found or has expired.");
    res.setHeader("Content-Type", "text/turtle; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="model-intake-preview-${run.runUuid}.ttl"`);
    return res.send(run.rdfPreview.turtle);
});

app.get("/runs/:runUuid/report", (req, res) => {
    const run = getPreflightRun(req.params.runUuid);
    if (!run) return buildErrorResponse(res, 404, "Preflight run was not found or has expired.");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="model-intake-report-${run.runUuid}.json"`);
    return res.send(JSON.stringify(safeRun(run), null, 2));
});

app.get("/model-versions/:versionId/semantic-summary", async (req, res) => {
    try {
        if (!loadModelIntakeConfig().workspaceEnabled) throw new IntakeError("model_intake_disabled", "The controlled model intake workspace is disabled.", 404);
        const versionId = modelId(req.params.versionId);
        const record = await database.getMaterialisationByVersion(versionId);
        if (!record) return buildErrorResponse(res, 404, "Semantic materialisation was not found.");
        return buildSuccessResponse(res, 200, { materialisationUuid: record.materialisation_uuid,
            status: record.status, namedGraphUri: record.named_graph_uri, mappingVersion: record.mapping_version,
            turtleSha256: record.turtle_sha256, tripleCount: Number(record.triple_count ?? 0),
            spaceCount: Number(record.space_count ?? 0), assetCount: Number(record.asset_count ?? 0),
            manifestationCount: Number(record.manifestation_count ?? 0), verifiedAt: record.verified_at });
    } catch (error) { return failure(res, error); }
});

app.get("/model-versions/:versionId/semantic-resources", async (req, res) => {
    try {
        if (!loadModelIntakeConfig().workspaceEnabled) throw new IntakeError("model_intake_disabled", "The controlled model intake workspace is disabled.", 404);
        const resources = await service.versionResources(modelId(req.params.versionId));
        if (!resources) return buildErrorResponse(res, 404, "Model version was not found.");
        return buildSuccessResponse(res, 200, resources);
    } catch (error) { return failure(res, error); }
});

async function sendVersionArtifact(req: express.Request, res: express.Response, filename: "model-version.ttl" | "semantic-report.json") {
    try {
        if (!loadModelIntakeConfig().workspaceEnabled) throw new IntakeError("model_intake_disabled", "The controlled model intake workspace is disabled.", 404);
        const snapshot = await database.getVersionSnapshot(modelId(req.params.versionId));
        if (!snapshot?.version.storage_key) return buildErrorResponse(res, 404, "Model version semantic artifact was not found.");
        const target = path.join(path.dirname(resolveStorageKey(snapshot.version.storage_key)), filename);
        if (!fs.existsSync(target)) return buildErrorResponse(res, 404, "Model version semantic artifact was not found.");
        res.setHeader("Content-Type", filename.endsWith(".ttl") ? "text/turtle; charset=utf-8" : "application/json; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        return res.send(fs.readFileSync(target));
    } catch (error) { return failure(res, error); }
}

app.get("/model-versions/:versionId/semantic-turtle", (req, res) => sendVersionArtifact(req, res, "model-version.ttl"));
app.get("/model-versions/:versionId/semantic-report", (req, res) => sendVersionArtifact(req, res, "semantic-report.json"));

app.use((error: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    removeUploadedFiles(req);
    if (error instanceof multer.MulterError) return buildErrorResponse(res, error.code === "LIMIT_FILE_SIZE" ? 413 : 400, "Upload limits were exceeded.");
    return buildErrorResponse(res, 500, "Controlled model intake upload failed.");
});

export default app;
