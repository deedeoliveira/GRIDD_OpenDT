import assert from "node:assert/strict";
import test from "node:test";
import { RegistryInstitutionalArtifactResolver } from "../../semantic/institutionalArtifactResolver.ts";
import { loadInstitutionalConfig } from "../../semantic/institutionalConfig.ts";
import { ActorInstitutionalLinkError } from "../../semantic/actorInstitutionalLinkTypes.ts";
import type { SemanticArtifactStatusSnapshot } from "../../utils/semanticArtifactDatabase.ts";

function snapshot(): SemanticArtifactStatusSnapshot {
    const families = [
        { id: 1, family_uuid: "f1", artifact_type: "ontology" as const, family_key: "uminho-institutional-ontology", name: "ontology", semantic_uri: "urn:o", privacy_policy: "public_research_artifact" as const, current_artifact_id: 11 },
        { id: 2, family_uuid: "f2", artifact_type: "institutional_dataset" as const, family_key: "uminho-institutional-synthetic-data", name: "dataset", semantic_uri: "urn:d", privacy_policy: "synthetic_runtime_data" as const, current_artifact_id: 22 },
        { id: 3, family_uuid: "f3", artifact_type: "bridge_vocabulary" as const, family_key: "project-institutional-bridge", name: "bridge", semantic_uri: "urn:b", privacy_policy: "public_research_artifact" as const, current_artifact_id: 33 },
    ];
    const artifacts = families.map((family, index) => ({
        id: Number(family.current_artifact_id), artifact_uuid: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        family_id: family.id, semantic_version: index === 2 ? "1.0.0" : "1.1.0", source_filename: "approved.ttl",
        repository_relative_path: "runtime/approved.ttl", byte_size: 1, sha256: "a".repeat(64), media_type: "text/turtle",
        serialization: "turtle", semantic_uri: "urn:x", named_graph_uri: `https://example.test/id/graph/${index}/artifact`,
        lifecycle_status: "active" as const, validation_status: "graph_verified" as const, validation_summary_json: {},
        privacy_classification: (index === 1 ? "synthetic_runtime_data" : "public_research_artifact") as "synthetic_runtime_data" | "public_research_artifact",
        predecessor_artifact_id: null,
    }));
    return { families, artifacts, operations: [] };
}

function resolver(data = snapshot()) {
    return new RegistryInstitutionalArtifactResolver({ statusSnapshot: async () => data } as any, loadInstitutionalConfig({}), { info() {}, error() {} });
}

test("artifact resolver returns active ontology, synthetic dataset and bridge revisions", async () => {
    const context = await resolver().resolve();
    assert.equal(context.dataset.artifactId, 22);
    assert.equal(context.datasetVersion, "1.1.0");
    assert.equal(context.bridgeVersion, "1.0.0");
});

test("artifact resolver rejects missing, non-verified, operational/test and non-synthetic dataset graphs", async () => {
    const mutations = [
        (data: SemanticArtifactStatusSnapshot) => { data.families[1]!.current_artifact_id = null; },
        (data: SemanticArtifactStatusSnapshot) => { data.artifacts[1]!.validation_status = "integrity_validated"; },
        (data: SemanticArtifactStatusSnapshot) => { data.artifacts[1]!.named_graph_uri = "https://example.test/id/graph/operational"; },
        (data: SemanticArtifactStatusSnapshot) => { data.artifacts[1]!.named_graph_uri = "https://example.test/id/graph/test/run"; },
        (data: SemanticArtifactStatusSnapshot) => { data.artifacts[1]!.privacy_classification = "public_research_artifact"; },
    ];
    for (const mutate of mutations) {
        const data = snapshot(); mutate(data);
        await assert.rejects(resolver(data).resolve(), (error: unknown) => error instanceof ActorInstitutionalLinkError && error.code === "institutional_artifact_not_active");
    }
});

test("institutional feature and demo mode default disabled", () => {
    const config = loadInstitutionalConfig({});
    assert.equal(config.graphEnabled, false);
    assert.equal(config.demoMode, false);
});
