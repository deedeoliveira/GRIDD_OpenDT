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
import { PyShaclValidationProvider } from "../semanticValidation/pyShaclValidationProvider.ts";
import { loadSemanticValidationConfig } from "../semanticValidation/semanticValidationConfig.ts";
import { loadSemanticEvidenceConfig } from "../semanticEvidence/semanticEvidenceConfig.ts";
import { SemanticEvidenceDatabase } from "../utils/semanticEvidenceDatabase.ts";
import { SemanticArtifactDatabase } from "../utils/semanticArtifactDatabase.ts";
import MySQLDatabase from "../utils/mysqlDatabase.ts";
import { createInstitutionalRuntime } from "../semantic/institutionalRuntime.ts";
import { resolveCurrentApplicationActor } from "../reservation/currentApplicationActor.ts";

async function main() {
    const execute = process.argv.includes("--execute");
    const config = loadSemanticEvidenceConfig();
    if (!config.enabled || config.mode !== "shadow" || !config.demoMode) {
        throw new Error("Local walkthrough requires SEMANTIC_EVIDENCE_ENABLED=true, SEMANTIC_ELIGIBILITY_MODE=shadow and SEMANTIC_EVIDENCE_DEMO_MODE=true.");
    }
    const currentActor = resolveCurrentApplicationActor();
    const demoActor = process.env.SEMANTIC_EVIDENCE_DEMO_CURRENT_ACTOR_KEY ?? currentActor;
    const prepareCurrentActorLink = process.env.SEMANTIC_EVIDENCE_DEMO_CURRENT_ACTOR_LINK_ENABLED === "true";
    if (demoActor.toLocaleLowerCase("en-US") !== currentActor.toLocaleLowerCase("en-US")) {
        throw new Error("SEMANTIC_EVIDENCE_DEMO_CURRENT_ACTOR_KEY must match CURRENT_APPLICATION_ACTOR_KEY.");
    }
    if (prepareCurrentActorLink && process.env.NODE_ENV === "production") {
        throw new Error("Current application actor demo linking is refused in production.");
    }
    const migrationReady = await new SemanticEvidenceDatabase().tablesReady();
    if (!migrationReady) throw new Error("Prompt 7F migration is not applied. Apply it manually before setup.");
    const artifactConfig = loadSemanticArtifactConfig();
    const manifest = await loadPublicArtifactManifest(artifactConfig.manifestPath);
    const keys = ["project-semantic-evidence-1.0.0", "project-reservation-eligibility-shadow-1.0.0"];
    const entries = keys.map((key) => manifest.artifacts.find((item) => item.artifactKey === key));
    if (entries.some((entry) => !entry)) throw new Error("Evidence vocabulary or shadow policy is absent from the public manifest.");
    const validation = new ArtifactValidationService(new FilesystemArtifactSource(artifactConfig.rootDir));
    const checked = await Promise.all(entries.map((entry) => validation.validate(entry!, true)));
    const shacl = loadSemanticValidationConfig();
    const policy = entries[1]!;
    const inspected = await new PyShaclValidationProvider().inspectShapes({ shapesTurtle: checked[1]!.payload.toString("utf8"),
        inference: "none", advanced: true, metaShacl: true, timeoutMs: shacl.timeoutMs, correlationId: crypto.randomUUID() });
    const graphConfig = loadGraphConfig();
    if (!graphConfig.configured) throw new Error(graphConfig.reason);
    const health = await getGraphClient().healthCheck();
    if (!health.ok) throw new Error(`Graph service is unavailable (${health.errorCode}).`);
    const registryDb = new SemanticArtifactDatabase();
    let activations: any[] = [];
    if (execute) {
        const registry = new ArtifactRegistryService(registryDb, { newUuid: () => crypto.randomUUID() });
        const loader = new ArtifactLoaderService(manifest, validation, registry, graphConfig.config,
            getGraphClient(), jsonSemanticArtifactLogger, artifactConfig.loadingEnabled);
        for (const entry of entries) activations.push(await loader.load({ artifactKey: entry!.artifactKey,
            idempotencyKey: `semantic-evidence-setup:${entry!.artifactKey}:${entry!.sha256}`, activate: true }));
    }
    let currentActorLink: { actorKey: string; agentUri: string; status: string; dryRun: boolean } | null = null;
    if (prepareCurrentActorLink) {
        currentActorLink = { actorKey: currentActor, agentUri: "https://example.org/uminho-phd/test/institutional/TestStudentPhD001",
            status: "verified", dryRun: !execute };
        if (execute) {
            const runtime = createInstitutionalRuntime();
            const link = await runtime.links.createVerifiedLink({ actorKey: currentActor,
                institutionalAgentUri: currentActorLink.agentUri, verificationSource: "semantic_evidence_demo_current_actor" });
            currentActorLink.status = link.status;
        }
    }
    const institutional = await registryDb.findFamilyByKey(process.env.INSTITUTIONAL_DATASET_FAMILY_KEY ?? "uminho-institutional-synthetic-data");
    const mapping = await registryDb.findFamilyByKey(process.env.IFC_RDF_MAPPING_FAMILY_KEY ?? "oswadt-ifc4-minimal-rdf-mapping");
    const shapes = await registryDb.findFamilyByKey(process.env.SHACL_MODEL_SHAPES_FAMILY_KEY ?? "oswadt-model-rdf-structural-shapes");
    if (!institutional?.current_artifact_id || !mapping?.current_artifact_id || !shapes?.current_artifact_id) {
        throw new Error("Institutional dataset, model mapping and structural shapes must already be active.");
    }
    const db = new MySQLDatabase(); await db.connect(); await db.checkConnection();
    const [actors]: any = await db.connection.execute(`SELECT actor_key,status FROM actor_institutional_links
        WHERE actor_key IN ('TEST-ACTOR-STUDENT-001','TEST-ACTOR-REVOKED-001') ORDER BY actor_key`);
    if (actors.length !== 2) throw new Error("The documented synthetic verified and revoked actors must exist before the walkthrough.");
    const [assets]: any = await db.connection.execute(`SELECT a.id,a.asset_uuid,a.asset_code,mv.version_uuid,
        msm.status AS materialisation_status,svr.conforms FROM assets a
        LEFT JOIN asset_bindings ab ON ab.asset_id=a.id
        LEFT JOIN model_versions mv ON mv.id=ab.model_version_id
        LEFT JOIN models m ON m.current_version_id=mv.id
        LEFT JOIN model_version_semantic_materialisations msm ON msm.model_version_id=mv.id AND msm.status='completed'
        LEFT JOIN semantic_validation_runs svr ON svr.model_version_id=mv.id AND svr.materialisation_id=msm.id AND svr.status='completed'
        WHERE m.current_version_id IS NOT NULL AND msm.id IS NOT NULL AND svr.conforms=1
        ORDER BY a.id, svr.id DESC LIMIT 1`);
    if (!assets[0]) throw new Error("A current synthetic asset with completed materialisation and conforming structural validation is required before the walkthrough.");
    const form = path.resolve(process.cwd(), "../front/app/(viewer)/student/ReservationModal.tsx");
    if (!fs.existsSync(form)) throw new Error("The real reservation form was not found.");
    console.log(JSON.stringify({ ok: true, dryRun: !execute, migrationReady, mysql: "available", graph: "available",
        policy: { artifactKey: policy.artifactKey, version: policy.semanticVersion, sha256: policy.sha256,
            constraintCount: inspected.constraints.length, activation: execute ? "active" : "planned" },
        evidenceVocabulary: { artifactKey: entries[0]!.artifactKey, sha256: entries[0]!.sha256,
            activation: execute ? "active" : "planned" },
        actors: actors.map((row: any) => ({ actorKey: row.actor_key, status: row.status })),
        currentApplicationActor: { actorKey: currentActor, authenticated: false, demoLink: currentActorLink },
        demoAsset: assets[0] ?? null, flags: { enabled: config.enabled, mode: config.mode, demoMode: config.demoMode },
        form: "student/ReservationModal.tsx", migrationsAppliedBySetup: 0, reservationsCreated: 0,
        reservationsCancelled: 0, graphResets: 0, activations: activations.map((row) => ({ artifactId: row.artifactId, graphUri: row.graphUri })),
        url: "http://localhost:3000/student" }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
    console.error(JSON.stringify({ ok: false, message: String(error?.message ?? error).slice(0, 1000) }));
    process.exit(1);
});
