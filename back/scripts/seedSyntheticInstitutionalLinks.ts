/** Explicit local seed. Never runs at application startup and never writes RDF. */
import "dotenv/config";
import crypto from "node:crypto";
import { getGraphClient } from "../graph/graphClientProvider.ts";
import { ActorInstitutionalLinkService } from "../semantic/actorInstitutionalLinkService.ts";
import { ActorInstitutionalLinkError, sanitizedLinkError } from "../semantic/actorInstitutionalLinkTypes.ts";
import { loadInstitutionalConfig } from "../semantic/institutionalConfig.ts";
import { RegistryBackedSyntheticLinkVerifier, seedSyntheticActorLinks } from "../semantic/syntheticActorLinkSeed.ts";
import { ActorInstitutionalLinkDatabase } from "../utils/actorInstitutionalLinkDatabase.ts";
import { SemanticArtifactDatabase } from "../utils/semanticArtifactDatabase.ts";

async function main(): Promise<void> {
    const config = loadInstitutionalConfig();
    if (!config.demoMode) throw new ActorInstitutionalLinkError("institutional_demo_disabled", "institutional demo mode is disabled", 404);
    const dryRun = process.argv.includes("--dry-run");
    if (dryRun) {
        console.log(JSON.stringify({ dryRun: true, links: await seedSyntheticActorLinks({} as ActorInstitutionalLinkService, { dryRun: true }) }, null, 2));
        return;
    }
    if (!config.graphEnabled) throw new ActorInstitutionalLinkError("institutional_feature_disabled", "institutional graph access is disabled", 503);
    const registry = new SemanticArtifactDatabase();
    const verifier = new RegistryBackedSyntheticLinkVerifier(registry, getGraphClient(), config.datasetFamilyKey);
    const service = new ActorInstitutionalLinkService(
        new ActorInstitutionalLinkDatabase(),
        verifier,
        { newUuid: () => crypto.randomUUID(), now: () => new Date() }
    );
    const links = await seedSyntheticActorLinks(service, { dryRun: false });
    console.log(JSON.stringify({ ok: true, syntheticOnly: true, rdfWrites: 0, links }, null, 2));
}

void main().then(
    () => process.exit(0),
    (error: unknown) => {
        console.error(JSON.stringify({ ok: false, ...sanitizedLinkError(error) }));
        process.exit(1);
    }
);
