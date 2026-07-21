import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Parser } from "n3";
import { getGraphClient } from "../graph/graphClientProvider.ts";
import { loadGraphConfig } from "../graph/graphConfig.ts";
import { semanticValidationReportGraphUri } from "../graph/namedGraphs.ts";
import { getPreflightRun, updatePreflightRun } from "../modelIntake/modelIntakeRunStore.ts";
import { resolveStorageKey } from "../utils/storage.ts";
import { ModelIntakeDatabase } from "../utils/modelIntakeDatabase.ts";
import { SemanticValidationDatabase } from "../utils/semanticValidationDatabase.ts";
import { loadSemanticValidationConfig } from "./semanticValidationConfig.ts";
import { PyShaclValidationProvider } from "./pyShaclValidationProvider.ts";
import { ShapeSetService } from "./shapeSetService.ts";
import { storePreviewValidation } from "./semanticValidationRunStore.ts";
import type { SemanticValidationProvider, SemanticValidationReport, ShapesSelection } from "./semanticValidationTypes.ts";
import { SemanticValidationError } from "./semanticValidationTypes.ts";

function sha256(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }

export function publicShapes(selection: ShapesSelection) {
    const { turtle: _turtle, ...publicSelection } = selection;
    return publicSelection;
}

export function publicValidation(report: SemanticValidationReport) {
    const { reportTurtle: _report, ...publicReport } = report;
    return publicReport;
}

export class SemanticValidationService {
    constructor(
        private readonly provider: SemanticValidationProvider = new PyShaclValidationProvider(),
        private readonly shapes = new ShapeSetService(undefined, provider),
        private readonly database = new SemanticValidationDatabase(),
        private readonly modelDatabase = new ModelIntakeDatabase(),
    ) {}

    async governedContext() {
        const config = loadSemanticValidationConfig();
        if (!config.enabled) return { enabled: false, mode: "disabled", temporaryShapesUploadEnabled: false, governedShapes: null };
        const selection = await this.shapes.resolveGoverned(config.modelShapesFamilyKey);
        return { enabled: true, mode: config.mode, temporaryShapesUploadEnabled: config.temporaryShapesUploadEnabled,
            governedShapes: publicShapes(selection), limits: { maxShapesBytes: config.maxShapesBytes } };
    }

    async inspectGoverned() { return this.shapes.resolveGoverned(); }

    async inspectTemporary(file: { path: string; originalname: string; size: number }, tempRoot: string, correlationId: string) {
        return this.shapes.inspectTemporary(file, tempRoot, correlationId);
    }

    async validatePreview(preflightRunUuid: string, selection: ShapesSelection): Promise<SemanticValidationReport> {
        const config = loadSemanticValidationConfig();
        if (!config.enabled) throw new SemanticValidationError("shacl_disabled", "SHACL validation is disabled.");
        const preflight = getPreflightRun(preflightRunUuid);
        if (!preflight) throw new SemanticValidationError("preflight_expired", "Run Validate and preview again before SHACL validation.");
        const report = await this.execute(preflight.rdfPreview.turtle, selection, {
            validationKind: "model_rdf_structural", modelVersionId: null, materialisationId: null,
            reportGraphUri: null, shapesSource: selection.source,
        });
        preflight.shaclValidation = report;
        updatePreflightRun(preflight);
        storePreviewValidation(report, preflight.rdfPreview.turtle, config.timeoutMs * 60);
        return report;
    }

    async execute(dataTurtle: string, selection: ShapesSelection, metadata: {
        validationKind: "model_rdf_structural" | "institutional_structural";
        modelVersionId: number | null;
        materialisationId: number | null;
        reportGraphUri: string | null;
        shapesSource: SemanticValidationReport["shapesSource"];
        ontologyTurtle?: string;
    }): Promise<SemanticValidationReport> {
        const config = loadSemanticValidationConfig();
        const runUuid = crypto.randomUUID();
        const started = Date.now();
        const dataGraphSha256 = sha256(dataTurtle);
        console.log(JSON.stringify({ type: "shacl_validation_started", correlationId: runUuid, dataHash: dataGraphSha256,
            shapesHash: selection.sha256, shapesArtifactId: selection.artifactId, mode: config.mode,
            modelVersionId: metadata.modelVersionId, at: new Date().toISOString() }));
        try {
            const result = await this.provider.validate({ dataTurtle, shapesTurtle: selection.turtle,
                ...(metadata.ontologyTurtle ? { ontologyTurtle: metadata.ontologyTurtle } : {}),
                inference: config.inference, advanced: config.advanced, metaShacl: config.metaShacl,
                timeoutMs: config.timeoutMs, correlationId: runUuid });
            const report: SemanticValidationReport = { ...result, runUuid, correlationId: runUuid,
                validationKind: metadata.validationKind, status: "completed", dataGraphSha256,
                shapesGraphSha256: selection.sha256, shapesSource: metadata.shapesSource,
                shapesArtifactId: selection.artifactId, shapesFamilyKey: selection.familyKey,
                shapesVersion: selection.version, shapesFilename: selection.filename,
                inferenceMode: config.inference, advanced: config.advanced, metaShacl: config.metaShacl,
                reportGraphUri: metadata.reportGraphUri, modelVersionId: metadata.modelVersionId,
                materialisationId: metadata.materialisationId };
            const severityCounts = report.results.reduce<Record<string, number>>((counts, row) => {
                const key = row.severity?.split("#").pop() ?? "Unknown"; counts[key] = (counts[key] ?? 0) + 1; return counts;
            }, {});
            console.log(JSON.stringify({ type: "shacl_validation_completed", correlationId: runUuid,
                dataHash: dataGraphSha256, shapesHash: selection.sha256, resultCount: report.resultCount,
                severityCounts, conforms: report.conforms, mode: config.mode, modelVersionId: metadata.modelVersionId,
                durationMs: Date.now() - started, at: new Date().toISOString() }));
            return report;
        } catch (error: any) {
            console.error(JSON.stringify({ type: "shacl_validation_failed", correlationId: runUuid,
                dataHash: dataGraphSha256, shapesHash: selection.sha256,
                errorCode: error?.code ?? "shacl_validation_failed", mode: config.mode,
                modelVersionId: metadata.modelVersionId, durationMs: Date.now() - started, at: new Date().toISOString() }));
            throw error;
        }
    }

    async persistModelReport(report: SemanticValidationReport, dataGraphUri: string, versionId: number, materialisationId: number) {
        if (report.shapesSource !== "governed_active_shapes" || report.shapesArtifactId === null) {
            throw new SemanticValidationError("temporary_shapes_cannot_activate", "Temporary shapes cannot decide model-version activation.");
        }
        const graph = loadGraphConfig();
        if (!graph.configured) throw new SemanticValidationError("graph_not_configured", graph.reason);
        const reportGraphUri = semanticValidationReportGraphUri(graph.config.baseUri, report.runUuid);
        const client = getGraphClient();
        const exists = await client.query(`ASK { GRAPH <${reportGraphUri}> { ?s ?p ?o } }`);
        const triples = new Parser().parse(report.reportTurtle).length;
        if (exists.boolean !== true) await client.putGraph(reportGraphUri, report.reportTurtle, "text/turtle");
        const counted = await client.query<{ count: { value: string } }>(`SELECT (COUNT(*) AS ?count) WHERE { GRAPH <${reportGraphUri}> { ?s ?p ?o } }`);
        if (Number(counted.results?.bindings?.[0]?.count?.value ?? -1) !== triples) {
            throw new SemanticValidationError("shacl_report_graph_verification_failed", "The SHACL report graph could not be verified remotely.");
        }
        const completed = { ...report, reportGraphUri, modelVersionId: versionId, materialisationId };
        await this.database.persistCompleted({ ...completed, dataGraphUri });
        const snapshot = await this.modelDatabase.getVersionSnapshot(versionId);
        if (!snapshot?.version.storage_key) throw new SemanticValidationError("model_version_storage_missing", "Model version storage is unavailable for the SHACL report.");
        const directory = path.dirname(resolveStorageKey(snapshot.version.storage_key));
        const turtlePath = path.join(directory, "shacl-report.ttl");
        const jsonPath = path.join(directory, "shacl-report.json");
        if (!fs.existsSync(turtlePath)) fs.writeFileSync(turtlePath, completed.reportTurtle, { encoding: "utf8", flag: "wx" });
        if (!fs.existsSync(jsonPath)) fs.writeFileSync(jsonPath, JSON.stringify(publicValidation(completed), null, 2), { encoding: "utf8", flag: "wx" });
        console.log(JSON.stringify({ type: "shacl_report_graph_verified", correlationId: report.runUuid,
            reportGraphUri, resultCount: report.resultCount, modelVersionId: versionId, at: new Date().toISOString() }));
        return completed;
    }
}
