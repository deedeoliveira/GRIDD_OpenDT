/** Explicit, non-destructive demo orchestrator. It never applies migrations. */
import "dotenv/config";
import { loadGraphConfig } from "../graph/graphConfig.ts";
import { getGraphClient } from "../graph/graphClientProvider.ts";
import { ArtifactLoaderService } from "../semantic/artifactLoaderService.ts";
import { ArtifactRegistryService } from "../semantic/artifactRegistryService.ts";
import { ArtifactValidationService } from "../semantic/artifactValidation.ts";
import { ActorInstitutionalLinkError, sanitizedLinkError } from "../semantic/actorInstitutionalLinkTypes.ts";
import { loadInstitutionalConfig } from "../semantic/institutionalConfig.ts";
import { createInstitutionalRuntime } from "../semantic/institutionalRuntime.ts";
import { FilesystemArtifactSource, loadPublicArtifactManifest } from "../semantic/publicArtifactManifest.ts";
import { loadSemanticArtifactConfig } from "../semantic/semanticArtifactConfig.ts";
import { institutionalLogger } from "../semantic/institutionalTypes.ts";
import { seedSyntheticActorLinks } from "../semantic/syntheticActorLinkSeed.ts";
import { SemanticArtifactDatabase } from "../utils/semanticArtifactDatabase.ts";

async function main(): Promise<void> {
    if (process.env.NODE_ENV === "production") throw new ActorInstitutionalLinkError("institutional_demo_disabled", "demo setup is refused in production", 400);
    const execute = process.argv.includes("--execute");
    const plan = ["validate public artifacts", "load/activate four public runtime artifacts", "seed four synthetic SQL actor links", "open http://localhost:3000/semantic-demo"];
    if (!execute) {
        console.log(JSON.stringify({ dryRun: true, migrationsApplied: false, destructiveOperations: 0, plan }, null, 2));
        return;
    }
    const config = loadInstitutionalConfig();
    if (!config.graphEnabled || !config.demoMode) throw new ActorInstitutionalLinkError("institutional_demo_disabled", "institutional graph and demo mode must be explicitly enabled", 400);
    const graph = loadGraphConfig();
    if (!graph.configured) throw new ActorInstitutionalLinkError("institutional_graph_unavailable", graph.reason, 503);
    const artifactConfig = loadSemanticArtifactConfig();
    const manifest = await loadPublicArtifactManifest(artifactConfig.manifestPath);
    const registry = new SemanticArtifactDatabase();
    const loader = new ArtifactLoaderService(
        manifest,
        new ArtifactValidationService(new FilesystemArtifactSource(artifactConfig.rootDir)),
        new ArtifactRegistryService(registry),
        graph.config,
        getGraphClient(),
        institutionalLogger,
        artifactConfig.loadingEnabled
    );
    await loader.loadPublic();
    const runtime = createInstitutionalRuntime(config);
    const links = await seedSyntheticActorLinks(runtime.links, { dryRun: false });
    console.log(JSON.stringify({ ok: true, migrationsApplied: false, links: links.length, url: "http://localhost:3000/semantic-demo" }, null, 2));
}

main().catch((error: unknown) => {
    console.error(JSON.stringify({ ok: false, ...sanitizedLinkError(error) }));
    process.exitCode = 1;
});
