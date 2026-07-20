import type { SemanticArtifactDatabasePort } from "../utils/semanticArtifactDatabase.ts";
import { ActorInstitutionalLinkError, type CurrentInstitutionalDataset } from "./actorInstitutionalLinkTypes.ts";
import type { InstitutionalArtifactContext, InstitutionalArtifactResolver, InstitutionalArtifactRevision, InstitutionalLogger } from "./institutionalTypes.ts";
import type { InstitutionalConfig } from "./institutionalConfig.ts";

export class RegistryInstitutionalArtifactResolver implements InstitutionalArtifactResolver {
    constructor(
        private readonly registry: SemanticArtifactDatabasePort,
        private readonly config: InstitutionalConfig,
        private readonly logger: InstitutionalLogger
    ) {}

    async resolve(): Promise<InstitutionalArtifactContext> {
        const snapshot = await this.registry.statusSnapshot();
        const ontology = this.revision(snapshot, this.config.ontologyFamilyKey, "ontology");
        const dataset = this.revision(snapshot, this.config.datasetFamilyKey, "institutional_dataset");
        const bridge = this.revision(snapshot, this.config.bridgeFamilyKey, "bridge_vocabulary");
        this.logger.info("institutional_artifact_context_resolved", {
            ontologyArtifactUuid: ontology.artifactUuid,
            datasetArtifactUuid: dataset.artifactUuid,
            bridgeArtifactUuid: bridge.artifactUuid,
        });
        return {
            ontology,
            dataset,
            bridge,
            ontologyVersion: ontology.semanticVersion,
            datasetVersion: dataset.semanticVersion,
            datasetArtifactUuid: dataset.artifactUuid,
            datasetGraphUri: dataset.namedGraphUri,
            bridgeVersion: bridge.semanticVersion,
        };
    }

    async resolveCurrentInstitutionalDataset(): Promise<CurrentInstitutionalDataset> {
        const context = await this.resolve();
        return {
            artifactId: context.dataset.artifactId,
            artifactUuid: context.dataset.artifactUuid,
            semanticVersion: context.dataset.semanticVersion,
            namedGraphUri: context.dataset.namedGraphUri,
            familyKey: context.dataset.familyKey,
        };
    }

    private revision(
        snapshot: Awaited<ReturnType<SemanticArtifactDatabasePort["statusSnapshot"]>>,
        familyKey: string,
        expectedType: string
    ): InstitutionalArtifactRevision {
        const family = snapshot.families.find((row) => row.family_key === familyKey);
        if (!family || family.artifact_type !== expectedType || family.current_artifact_id === null) {
            throw new ActorInstitutionalLinkError("institutional_artifact_not_active", `required institutional artifact family '${familyKey}' is not active`, 503);
        }
        const artifact = snapshot.artifacts.find((row) => Number(row.id) === Number(family.current_artifact_id));
        if (!artifact || artifact.lifecycle_status !== "active" || artifact.validation_status !== "graph_verified") {
            throw new ActorInstitutionalLinkError("institutional_artifact_not_active", `current artifact for '${familyKey}' is not graph-verified`, 503);
        }
        if (artifact.named_graph_uri.includes("/graph/operational") || artifact.named_graph_uri.includes("/graph/test/")) {
            throw new ActorInstitutionalLinkError("institutional_artifact_not_active", "institutional artifact graph namespace is not permitted", 503);
        }
        if (expectedType === "institutional_dataset" && artifact.privacy_classification !== "synthetic_runtime_data") {
            throw new ActorInstitutionalLinkError("institutional_artifact_not_active", "only the active synthetic institutional dataset is allowed", 503);
        }
        return {
            artifactId: Number(artifact.id),
            artifactUuid: artifact.artifact_uuid,
            familyKey: family.family_key,
            semanticVersion: artifact.semantic_version,
            namedGraphUri: artifact.named_graph_uri,
        };
    }
}
