import { getGraphClient } from "../graph/graphClientProvider.ts";
import { ActorInstitutionalLinkDatabase } from "../utils/actorInstitutionalLinkDatabase.ts";
import { SemanticArtifactDatabase } from "../utils/semanticArtifactDatabase.ts";
import { ActorInstitutionalLinkService } from "./actorInstitutionalLinkService.ts";
import { FusekiInstitutionalGraphProvider } from "./fusekiInstitutionalGraphProvider.ts";
import { RegistryInstitutionalArtifactResolver } from "./institutionalArtifactResolver.ts";
import { loadInstitutionalConfig, type InstitutionalConfig } from "./institutionalConfig.ts";
import { InstitutionalContextService } from "./institutionalContextService.ts";
import { institutionalLogger } from "./institutionalTypes.ts";
import { RegistryBackedSyntheticLinkVerifier } from "./syntheticActorLinkSeed.ts";

export function createInstitutionalRuntime(config: InstitutionalConfig = loadInstitutionalConfig()) {
    const registry = new SemanticArtifactDatabase();
    const graphClient = getGraphClient();
    const resolver = new RegistryInstitutionalArtifactResolver(registry, config, institutionalLogger);
    const provider = new FusekiInstitutionalGraphProvider(graphClient, resolver, institutionalLogger);
    const verifier = new RegistryBackedSyntheticLinkVerifier(registry, graphClient, config.datasetFamilyKey);
    const links = new ActorInstitutionalLinkService(new ActorInstitutionalLinkDatabase(), verifier);
    const context = new InstitutionalContextService(links, provider, institutionalLogger);
    return { registry, graphClient, resolver, provider, verifier, links, context };
}
