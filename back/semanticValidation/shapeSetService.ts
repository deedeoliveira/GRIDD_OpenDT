import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Parser } from "n3";
import { loadGraphConfig } from "../graph/graphConfig.ts";
import { structuralShapesGraphUri } from "../graph/namedGraphs.ts";
import { SemanticArtifactDatabase, type SemanticArtifactDatabasePort } from "../utils/semanticArtifactDatabase.ts";
import { loadSemanticValidationConfig } from "./semanticValidationConfig.ts";
import { PyShaclValidationProvider } from "./pyShaclValidationProvider.ts";
import type { SemanticValidationProvider, ShapesSelection } from "./semanticValidationTypes.ts";
import { SemanticValidationError } from "./semanticValidationTypes.ts";

const OWL_IMPORTS = "http://www.w3.org/2002/07/owl#imports";
const ALLOWED_MODEL_NAMESPACES = [
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "http://www.w3.org/2000/01/rdf-schema#",
    "http://www.w3.org/2001/XMLSchema#",
    "http://www.w3.org/2002/07/owl#",
    "http://www.w3.org/ns/shacl#",
    "http://www.w3.org/ns/prov#",
    "http://purl.org/dc/terms/",
    "https://w3id.org/bot#",
    "https://pi.pauwel.be/voc/buildingelement#",
    "https://deedeoliveira.github.io/GRIDD_OpenDT/ontology/model-intake-v1#",
];

function hash(bytes: Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }

function safeFilename(name: string): string {
    if (!name || name !== path.basename(name) || /[\\/\0]/.test(name) || path.extname(name).toLowerCase() !== ".ttl") {
        throw new SemanticValidationError("invalid_shapes_filename", "Select a safe .ttl shapes filename.");
    }
    return name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 200);
}

export function validateShapesTurtleSecurity(turtle: string, enforceModelAllowlist: boolean) {
    let quads;
    try { quads = new Parser().parse(turtle); }
    catch { throw new SemanticValidationError("invalid_shapes_turtle", "The selected shapes file is not valid Turtle."); }
    if (!quads.length) throw new SemanticValidationError("empty_shapes_graph", "The selected shapes graph is empty.");
    if (quads.some((quad) => quad.predicate.value === OWL_IMPORTS)) {
        throw new SemanticValidationError("shapes_imports_forbidden", "Shapes containing owl:imports are not allowed.");
    }
    if (quads.some((quad) => quad.graph.termType !== "DefaultGraph")) {
        throw new SemanticValidationError("client_graph_uri_forbidden", "The client cannot choose a shapes graph URI.");
    }
    if (enforceModelAllowlist) {
        const predicates = quads.map((quad) => quad.predicate.value);
        if (predicates.some((iri) => !ALLOWED_MODEL_NAMESPACES.some((prefix) => iri.startsWith(prefix)))) {
            throw new SemanticValidationError("shapes_namespace_forbidden", "Shapes use a predicate outside the model-RDF namespace allowlist.");
        }
    }
    return quads.length;
}

export class ShapeSetService {
    constructor(
        private readonly db: SemanticArtifactDatabasePort = new SemanticArtifactDatabase(),
        private readonly provider: SemanticValidationProvider = new PyShaclValidationProvider(),
    ) {}

    async resolveGoverned(familyKey = loadSemanticValidationConfig().modelShapesFamilyKey): Promise<ShapesSelection> {
        const config = loadSemanticValidationConfig();
        const family = await this.db.findFamilyByKey(familyKey);
        if (!family || family.artifact_type !== "shacl_shapes" || family.current_artifact_id === null) {
            throw new SemanticValidationError("governed_shapes_unavailable", `No active governed shapes exist for '${familyKey}'.`);
        }
        const artifact = await this.db.findArtifactById(Number(family.current_artifact_id));
        if (!artifact || artifact.lifecycle_status !== "active" || artifact.validation_status !== "graph_verified"
            || artifact.storage_mode !== "graph_backed" || artifact.privacy_classification !== "public_research_artifact") {
            throw new SemanticValidationError("governed_shapes_invalid", "The active shapes artifact is not public, graph-verified and graph-backed.");
        }
        const graph = loadGraphConfig();
        if (!graph.configured) throw new SemanticValidationError("graph_not_configured", graph.reason);
        const expectedGraph = structuralShapesGraphUri(graph.config.baseUri, artifact.artifact_uuid);
        if (artifact.named_graph_uri !== expectedGraph) throw new SemanticValidationError("governed_shapes_graph_mismatch", "The active shapes graph URI is not governed.");
        const root = path.resolve(config.artifactRoot);
        const absolutePath = path.resolve(root, artifact.repository_relative_path);
        if (!absolutePath.startsWith(root + path.sep)) throw new SemanticValidationError("governed_shapes_path_invalid", "The governed shapes path escapes the artifact root.");
        const bytes = fs.readFileSync(absolutePath);
        if (hash(bytes) !== artifact.sha256 || bytes.length !== Number(artifact.byte_size)) {
            throw new SemanticValidationError("governed_shapes_integrity_failed", "The governed shapes file failed hash or size verification.");
        }
        const turtle = bytes.toString("utf8");
        validateShapesTurtleSecurity(turtle, familyKey === config.modelShapesFamilyKey);
        const inspected = await this.provider.inspectShapes({ shapesTurtle: turtle, inference: config.inference,
            advanced: config.advanced, metaShacl: config.metaShacl, timeoutMs: config.timeoutMs,
            correlationId: crypto.randomUUID() });
        console.log(JSON.stringify({ type: "shacl_shapes_resolved", shapesHash: artifact.sha256,
            shapesArtifactId: Number(artifact.id), familyKey, version: artifact.semantic_version,
            constraintCount: inspected.constraints.length, at: new Date().toISOString() }));
        return { source: "governed_active_shapes", filename: path.basename(absolutePath), familyKey,
            version: artifact.semantic_version, sha256: artifact.sha256, artifactId: Number(artifact.id),
            artifactUuid: artifact.artifact_uuid, namedGraphUri: artifact.named_graph_uri, turtle,
            constraints: inspected.constraints, executorName: inspected.executorName, executorVersion: inspected.executorVersion };
    }

    async inspectTemporary(file: { path: string; originalname: string; size: number }, tempRoot: string, correlationId: string): Promise<ShapesSelection> {
        const config = loadSemanticValidationConfig();
        if (!config.temporaryShapesUploadEnabled) throw new SemanticValidationError("temporary_shapes_disabled", "Temporary shapes upload is disabled.");
        if (file.size > config.maxShapesBytes) throw new SemanticValidationError("temporary_shapes_too_large", "The temporary shapes file exceeds the configured size limit.");
        const filename = safeFilename(file.originalname);
        const root = fs.realpathSync(path.resolve(tempRoot));
        const actual = fs.realpathSync(file.path);
        if (!actual.startsWith(root + path.sep) || fs.lstatSync(actual).isSymbolicLink()) {
            throw new SemanticValidationError("temporary_shapes_path_invalid", "The temporary shapes upload path is invalid.");
        }
        const bytes = fs.readFileSync(actual);
        const turtle = bytes.toString("utf8");
        validateShapesTurtleSecurity(turtle, true);
        const inspected = await this.provider.inspectShapes({ shapesTurtle: turtle, inference: config.inference,
            advanced: config.advanced, metaShacl: config.metaShacl, timeoutMs: config.timeoutMs, correlationId });
        console.log(JSON.stringify({ type: "temporary_shapes_received", correlationId, shapesHash: hash(bytes),
            byteSize: bytes.length, constraintCount: inspected.constraints.length, at: new Date().toISOString() }));
        return { source: "temporary_uploaded_shapes", filename, familyKey: null, version: null,
            sha256: hash(bytes), artifactId: null, artifactUuid: null, namedGraphUri: null, turtle,
            constraints: inspected.constraints, executorName: inspected.executorName, executorVersion: inspected.executorVersion };
    }
}
