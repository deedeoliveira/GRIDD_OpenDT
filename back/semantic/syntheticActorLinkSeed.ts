import type { GraphClient } from "../graph/graphTypes.ts";
import { iri } from "../graph/sparqlText.ts";
import type { SemanticArtifactDatabasePort } from "../utils/semanticArtifactDatabase.ts";
import {
    ActorInstitutionalLinkError,
    type CurrentInstitutionalDataset,
    type InstitutionalLinkVerifier,
} from "./actorInstitutionalLinkTypes.ts";
import type { ActorInstitutionalLinkService } from "./actorInstitutionalLinkService.ts";

export const SYNTHETIC_ACTOR_LINKS = [
    {
        actorKey: "TEST-ACTOR-STUDENT-001",
        agentUri: "https://example.org/uminho-phd/test/institutional/TestStudentPhD001",
        targetStatus: "verified",
    },
    {
        actorKey: "TEST-ACTOR-STUDENT-002",
        agentUri: "https://example.org/uminho-phd/test/institutional/TestStudentPhD002",
        targetStatus: "verified",
    },
    {
        actorKey: "TEST-ACTOR-PROFESSOR-001",
        agentUri: "https://example.org/uminho-phd/test/institutional/TestProfessor001",
        targetStatus: "verified",
    },
    {
        actorKey: "TEST-ACTOR-REVOKED-001",
        agentUri: "https://example.org/uminho-phd/test/institutional/TestResearcher001",
        targetStatus: "revoked",
    },
] as const;

export class RegistryBackedSyntheticLinkVerifier implements InstitutionalLinkVerifier {
    constructor(
        private readonly registry: SemanticArtifactDatabasePort,
        private readonly graphClient: GraphClient,
        private readonly datasetFamilyKey: string
    ) {}

    async resolveCurrentInstitutionalDataset(): Promise<CurrentInstitutionalDataset> {
        const snapshot = await this.registry.statusSnapshot();
        const family = snapshot.families.find((row) => row.family_key === this.datasetFamilyKey);
        if (!family || family.artifact_type !== "institutional_dataset" || family.current_artifact_id === null) {
            throw new ActorInstitutionalLinkError("institutional_artifact_not_active", "active institutional synthetic dataset was not found", 503);
        }
        const artifact = snapshot.artifacts.find((row) => Number(row.id) === Number(family.current_artifact_id));
        if (!artifact || artifact.lifecycle_status !== "active" || artifact.validation_status !== "graph_verified"
            || artifact.named_graph_uri === null || artifact.storage_mode === "file_executed"
            || artifact.privacy_classification !== "synthetic_runtime_data" || artifact.named_graph_uri.includes("/graph/test/")) {
            throw new ActorInstitutionalLinkError("institutional_artifact_not_active", "institutional dataset current pointer is not eligible", 503);
        }
        return {
            artifactId: Number(artifact.id),
            artifactUuid: artifact.artifact_uuid,
            semanticVersion: artifact.semantic_version,
            namedGraphUri: artifact.named_graph_uri,
            familyKey: family.family_key,
        };
    }

    async agentExists(agentUri: string, dataset: CurrentInstitutionalDataset): Promise<boolean> {
        const result = await this.graphClient.query(
            `ASK { GRAPH ${iri(dataset.namedGraphUri)} { ${iri(agentUri)} ?predicate ?object } }`
        );
        if (typeof result.boolean !== "boolean") {
            throw new ActorInstitutionalLinkError("institutional_response_invalid", "graph returned an invalid existence response", 503);
        }
        return result.boolean;
    }
}

export async function seedSyntheticActorLinks(
    service: ActorInstitutionalLinkService,
    options: { dryRun: boolean }
): Promise<Array<{ actorKey: string; agentUri: string; status: string; dryRun: boolean }>> {
    if (options.dryRun) {
        return SYNTHETIC_ACTOR_LINKS.map((item) => ({
            actorKey: item.actorKey,
            agentUri: item.agentUri,
            status: item.targetStatus,
            dryRun: true,
        }));
    }
    const results: Array<{ actorKey: string; agentUri: string; status: string; dryRun: boolean }> = [];
    for (const item of SYNTHETIC_ACTOR_LINKS) {
        const latest = await service.getLatestLinkForActor(item.actorKey);
        if (latest && latest.institutional_agent_uri === item.agentUri && latest.status === item.targetStatus) {
            results.push({ actorKey: item.actorKey, agentUri: item.agentUri, status: latest.status, dryRun: false });
            continue;
        }
        const verified = await service.createVerifiedLink({
            actorKey: item.actorKey,
            institutionalAgentUri: item.agentUri,
            verificationSource: "synthetic_demo_seed",
        });
        const final = item.targetStatus === "revoked" ? await service.revokeLink(verified.link_uuid) : verified;
        results.push({ actorKey: item.actorKey, agentUri: item.agentUri, status: final.status, dryRun: false });
    }
    return results;
}
