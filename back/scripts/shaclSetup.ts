import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadGraphConfig } from "../graph/graphConfig.ts";
import { getGraphClient } from "../graph/graphClientProvider.ts";
import { ArtifactLoaderService } from "../semantic/artifactLoaderService.ts";
import { ArtifactRegistryService } from "../semantic/artifactRegistryService.ts";
import { jsonSemanticArtifactLogger } from "../semantic/artifactTypes.ts";
import { ArtifactValidationService } from "../semantic/artifactValidation.ts";
import { FilesystemArtifactSource, loadPublicArtifactManifest } from "../semantic/publicArtifactManifest.ts";
import { loadSemanticArtifactConfig } from "../semantic/semanticArtifactConfig.ts";
import { loadSemanticValidationConfig } from "../semanticValidation/semanticValidationConfig.ts";
import { PyShaclValidationProvider } from "../semanticValidation/pyShaclValidationProvider.ts";
import { validateShapesTurtleSecurity } from "../semanticValidation/shapeSetService.ts";
import { SemanticArtifactDatabase } from "../utils/semanticArtifactDatabase.ts";
import { SemanticValidationDatabase } from "../utils/semanticValidationDatabase.ts";

async function main() {
    const execute = process.argv.includes("--execute");
    const shacl = loadSemanticValidationConfig();
    if (!shacl.enabled || shacl.mode !== "required" || !shacl.temporaryShapesUploadEnabled) {
        throw new Error("Local walkthrough requires SHACL_VALIDATION_ENABLED=true, SHACL_VALIDATION_MODE=required and TEMPORARY_SHAPES_UPLOAD_ENABLED=true.");
    }
    const migrationReady = await new SemanticValidationDatabase().tablesReady();
    if (!migrationReady) throw new Error("Prompt 7E migration is not applied. Apply it manually before setup.");
    const artifactConfig = loadSemanticArtifactConfig();
    const manifest = await loadPublicArtifactManifest(artifactConfig.manifestPath);
    const entry = manifest.artifacts.find((item) => item.artifactKey === `${shacl.modelShapesFamilyKey}-1.0.0`);
    if (!entry || entry.artifactType !== "shacl_shapes" || entry.storageMode !== "graph_backed") throw new Error("Governed model RDF shapes are absent from the public manifest.");
    const validation = new ArtifactValidationService(new FilesystemArtifactSource(artifactConfig.rootDir));
    const checked = await validation.validate(entry, true);
    const turtle = checked.payload.toString("utf8");
    validateShapesTurtleSecurity(turtle, true);
    const provider = new PyShaclValidationProvider();
    const inspected = await provider.inspectShapes({ shapesTurtle: turtle, inference: shacl.inference,
        advanced: shacl.advanced, metaShacl: shacl.metaShacl, timeoutMs: shacl.timeoutMs,
        correlationId: crypto.randomUUID() });
    const graphConfig = loadGraphConfig();
    if (!graphConfig.configured) throw new Error(graphConfig.reason);
    const graph = await getGraphClient().healthCheck();
    if (!graph.ok) throw new Error(`Graph service is unavailable (${graph.errorCode}).`);
    const database = new SemanticArtifactDatabase();
    const mapping = await database.findFamilyByKey(process.env.IFC_RDF_MAPPING_FAMILY_KEY ?? "oswadt-ifc4-minimal-rdf-mapping");
    const ids = await database.findFamilyByKey(process.env.IDS_PROFILE_FAMILY_KEY ?? "oswadt-ifc4-model-requirements");
    if (!mapping?.current_artifact_id || !ids?.current_artifact_id) throw new Error("Active governed mapping and IDS are required.");
    const inputs = [
        path.resolve(process.cwd(), "../documentation/demo-inputs/model-intake/model-v1.ifc"),
        path.resolve(process.cwd(), "../documentation/demo-inputs/model-intake/ids-reference-required.ids"),
        path.resolve(process.cwd(), "../documentation/demo-inputs/shacl/temporary-manifestation-description-required.ttl"),
    ];
    if (inputs.some((file) => !fs.existsSync(file))) throw new Error("One or more controlled walkthrough inputs are missing.");
    let activation: any = { status: "planned" };
    if (execute) {
        const registry = new ArtifactRegistryService(database, { newUuid: () => crypto.randomUUID() });
        const loader = new ArtifactLoaderService(manifest, validation, registry, graphConfig.config,
            getGraphClient(), jsonSemanticArtifactLogger, artifactConfig.loadingEnabled);
        activation = await loader.load({ artifactKey: entry.artifactKey,
            idempotencyKey: `shacl-setup:${entry.artifactKey}:${entry.sha256}`, activate: true });
    }
    console.log(JSON.stringify({ ok: true, dryRun: !execute, migrationReady, mysql: "available", graph: "available",
        pyShacl: `${inspected.executorName} ${inspected.executorVersion}`, governedShapes: {
            artifactKey: entry.artifactKey, version: entry.semanticVersion, sha256: entry.sha256,
            constraintCount: inspected.constraints.length, activation: execute ? "active" : "planned",
            ...(execute ? { artifactId: activation.artifactId, graphUri: activation.graphUri } : {}),
        }, mappingActive: true, idsActive: true, inputs: inputs.map((file) => path.basename(file)),
        migrationsAppliedBySetup: 0, automaticModelVersionsCreated: 0, graphResets: 0,
        negativeFixtureLoadedToActiveGraph: false, url: "http://localhost:3000/dashboard" }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
    console.error(JSON.stringify({ ok: false, message: String(error?.message ?? error).slice(0, 1000) }));
    process.exit(1);
});
