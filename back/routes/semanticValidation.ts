import express from "express";
import fs from "node:fs";
import path from "node:path";
import { buildErrorResponse, buildSuccessResponse } from "../utils/responseHandler.ts";
import { SemanticValidationDatabase } from "../utils/semanticValidationDatabase.ts";
import { ModelIntakeDatabase } from "../utils/modelIntakeDatabase.ts";
import { resolveStorageKey } from "../utils/storage.ts";
import { getPreviewValidation } from "../semanticValidation/semanticValidationRunStore.ts";
import { publicValidation } from "../semanticValidation/semanticValidationService.ts";

const app = express.Router();
const database = new SemanticValidationDatabase();
const models = new ModelIntakeDatabase();

function validUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function resolved(runUuid: string) {
    const preview = getPreviewValidation(runUuid);
    if (preview) return { kind: "preview" as const, ...preview };
    const persisted = await database.getRun(runUuid);
    if (!persisted) return null;
    const run = persisted.run;
    return { kind: "persisted" as const, report: {
        runUuid: run.run_uuid, correlationId: run.run_uuid, validationKind: run.validation_kind,
        status: run.status, conforms: Boolean(run.conforms), resultCount: Number(run.result_count ?? 0),
        results: persisted.results, constraints: [], dataGraphSha256: run.data_graph_sha256,
        shapesGraphSha256: run.shapes_sha256, shapesSource: run.shapes_source,
        shapesArtifactId: run.shapes_artifact_id, shapesFamilyKey: null, shapesVersion: null,
        shapesFilename: "governed-shapes.ttl", executorName: run.executor_name,
        executorVersion: run.executor_version, inferenceMode: run.inference_mode,
        advanced: Boolean(run.advanced_enabled), metaShacl: Boolean(run.meta_shacl_enabled),
        startedAt: run.started_at, completedAt: run.completed_at, reportTurtle: "",
        reportSha256: run.report_sha256, reportGraphUri: run.report_graph_uri,
        modelVersionId: run.model_version_id, materialisationId: run.materialisation_id,
    }, modelVersionId: Number(run.model_version_id) };
}

app.get("/runs/:runUuid", async (req, res) => {
    if (!validUuid(req.params.runUuid)) return buildErrorResponse(res, 400, "A valid run UUID is required.");
    const value = await resolved(req.params.runUuid);
    if (!value) return buildErrorResponse(res, 404, "Semantic validation run was not found.");
    return buildSuccessResponse(res, 200, publicValidation(value.report as any));
});

app.get("/runs/:runUuid/report", async (req, res) => {
    const value = validUuid(req.params.runUuid) ? await resolved(req.params.runUuid) : null;
    if (!value) return buildErrorResponse(res, 404, "Semantic validation run was not found.");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="shacl-report-${req.params.runUuid}.json"`);
    return res.send(JSON.stringify(publicValidation(value.report as any), null, 2));
});

async function persistedFile(versionId: number, filename: string) {
    const snapshot = await models.getVersionSnapshot(versionId);
    if (!snapshot?.version.storage_key) return null;
    const target = path.join(path.dirname(resolveStorageKey(snapshot.version.storage_key)), filename);
    return fs.existsSync(target) ? target : null;
}

app.get("/runs/:runUuid/report.ttl", async (req, res) => {
    const value = validUuid(req.params.runUuid) ? await resolved(req.params.runUuid) : null;
    if (!value) return buildErrorResponse(res, 404, "Semantic validation run was not found.");
    let turtle = value.kind === "preview" ? value.report.reportTurtle : null;
    if (!turtle && value.kind === "persisted") {
        const file = await persistedFile(value.modelVersionId, "shacl-report.ttl");
        if (file) turtle = fs.readFileSync(file, "utf8");
    }
    if (!turtle) return buildErrorResponse(res, 404, "SHACL report Turtle was not found.");
    res.setHeader("Content-Type", "text/turtle; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="shacl-report-${req.params.runUuid}.ttl"`);
    return res.send(turtle);
});

app.get("/runs/:runUuid/data.ttl", async (req, res) => {
    const value = validUuid(req.params.runUuid) ? await resolved(req.params.runUuid) : null;
    if (!value) return buildErrorResponse(res, 404, "Semantic validation run was not found.");
    let turtle = value.kind === "preview" ? value.dataTurtle : null;
    if (!turtle && value.kind === "persisted") {
        const file = await persistedFile(value.modelVersionId, "model-version.ttl");
        if (file) turtle = fs.readFileSync(file, "utf8");
    }
    if (!turtle) return buildErrorResponse(res, 404, "Validated data Turtle was not found.");
    res.setHeader("Content-Type", "text/turtle; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="validated-data-${req.params.runUuid}.ttl"`);
    return res.send(turtle);
});

export default app;
