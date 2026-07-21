import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GraphClient } from "../../graph/graphTypes.ts";
import type { InstitutionalActorContext } from "../../semantic/institutionalTypes.ts";
import { PyShaclValidationProvider } from "../../semanticValidation/pyShaclValidationProvider.ts";
import { ReservationSemanticEvidenceService } from "../../semanticEvidence/reservationSemanticEvidenceService.ts";
import type { PolicySelection, ResourceSemanticRow, SemanticEvidenceResponse } from "../../semanticEvidence/semanticEvidenceTypes.ts";
import type { SemanticEvidenceDatabasePort } from "../../utils/semanticEvidenceDatabase.ts";

const NOW = new Date("2035-01-01T12:00:00.000Z");
const START = "2035-01-02T10:00:00.000Z";
const END = "2035-01-02T11:00:00.000Z";
const BASE = "http://oswadt.local/id";
const RUN = "11111111-1111-4111-8111-111111111111";
const ROLE = "http://www.semanticweb.org/dekao/ontologies/2024/UMinho#DoctoralStudentRole";

class MemoryGraph implements GraphClient {
    providerId = "memory";
    graphs = new Map<string, string>();
    async healthCheck() { return { ok: true, provider: "memory", queryEndpoint: "memory", durationMs: 0, errorCode: null, error: null }; }
    async query(sparql: string) { const uri = /GRAPH <([^>]+)>/.exec(sparql)?.[1]; return { boolean: uri ? this.graphs.has(uri) : false }; }
    async update() {}
    async putGraph(uri: string, payload: string) { this.graphs.set(uri, payload); }
    async getGraph(uri: string) { return this.graphs.get(uri) ?? ""; }
    async deleteGraph(uri: string) { this.graphs.delete(uri); }
}

class MemoryDb implements SemanticEvidenceDatabasePort {
    persisted: any = null;
    links: any[] = [];
    constructor(public resource: ResourceSemanticRow | null = resourceRow()) {}
    async resolveResource() { return this.resource; }
    async persistCompleted(input: any) { this.persisted = input; return { id: 7 }; }
    async getRun(runUuid: string) {
        if (!this.persisted || runUuid !== this.persisted.runUuid) return null;
        return { id: 7, row: { actor_key_normalized: "test-actor-student-001", asset_id: 9,
            requested_start: new Date(START), requested_end: new Date(END), expires_at: new Date(this.persisted.expiresAt) },
            response: this.persisted as SemanticEvidenceResponse };
    }
    async linkReservation(runId: number, reservationId: number, snapshotSha256: string) { this.links.push({ runId, reservationId, snapshotSha256 }); }
    async tablesReady() { return true; }
}

function resourceRow(overrides: Partial<ResourceSemanticRow> = {}): ResourceSemanticRow {
    return { asset_id: 9, asset_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tag: "EQP-DEMO-001", location: "ROOM-DEMO-001",
        model_version_id: 11, version_uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", materialisation_id: 12,
        materialisation_uuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", named_graph_uri: `${BASE}/graph/model-version/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
        ifc_guid: "3DemoGuid", structural_validation_run_id: 13,
        structural_validation_run_uuid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", structural_conforms: 1,
        shapes_artifact_id: 14, shapes_version: "1.0.0", ...overrides };
}

function context(status: "verified" | "revoked" = "verified"): InstitutionalActorContext {
    return { actorKey: status === "verified" ? "TEST-ACTOR-STUDENT-001" : "TEST-ACTOR-REVOKED-001",
        contextAvailable: status === "verified", unavailableReason: status === "verified" ? null : "actor_link_revoked",
        link: { linkId: 5, institutionalDatasetArtifactId: 2, linkUuid: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            status, linkType: "represents_institutional_actor", validFrom: null, validTo: null,
            verifiedAt: status === "verified" ? NOW.toISOString() : null, verificationSource: "synthetic_demo_seed" },
        person: status === "verified" ? { uri: "https://example.org/test/TestStudent001", label: "synthetic", studentNumber: null, types: [] } : null,
        memberships: status === "verified" ? [{ membershipUri: "https://example.org/test/membership/1",
            organization: { uri: "https://example.org/test/org/1", label: "Synthetic research group" },
            roles: [{ uri: ROLE, label: "Doctoral student" }] }] : [],
        roles: status === "verified" ? [{ uri: ROLE, label: "Doctoral student" }] : [], supervisors: [],
        artifactContext: status === "verified" ? { ontology: revision("ontology", 1), dataset: revision("dataset", 2), bridge: revision("bridge", 3),
            ontologyVersion: "1.1.0", datasetVersion: "1.1.0", datasetArtifactUuid: "22222222-2222-4222-8222-222222222222",
            datasetGraphUri: `${BASE}/graph/institutional-data/synthetic/22222222-2222-4222-8222-222222222222`, bridgeVersion: "1.0.0" } : null,
        caveats: ["actor_key_is_not_authenticated"] };
}

function revision(familyKey: string, artifactId: number) {
    return { artifactId, artifactUuid: `${artifactId}`.padStart(8, "0") + "-2222-4222-8222-222222222222".slice(8),
        familyKey, semanticVersion: "1.0.0", namedGraphUri: `${BASE}/graph/${familyKey}` };
}

async function policy(): Promise<PolicySelection> {
    const file = path.resolve(process.cwd(), "../semantic/artifacts/runtime/project-reservation-eligibility-shadow/1.0.0/project-reservation-eligibility-shadow-v1.ttl");
    const turtle = fs.readFileSync(file, "utf8");
    const provider = new PyShaclValidationProvider();
    const inspected = await provider.inspectShapes({ shapesTurtle: turtle, inference: "none", advanced: true, metaShacl: true,
        timeoutMs: 30000, correlationId: crypto.randomUUID() });
    return { artifactId: 20, artifactUuid: "ffffffff-ffff-4fff-8fff-ffffffffffff", familyKey: "project-reservation-eligibility-shadow",
        filename: path.basename(file), version: "1.0.0", sha256: crypto.createHash("sha256").update(turtle).digest("hex"),
        namedGraphUri: `${BASE}/graph/validation/policy/ffffffff-ffff-4fff-8fff-ffffffffffff`, turtle, ...inspected };
}

async function runtime(options: { actor?: InstitutionalActorContext; resource?: ResourceSemanticRow | null; approved?: boolean; actorConflict?: boolean } = {}) {
    const database = new MemoryDb(options.resource === undefined ? resourceRow() : options.resource);
    const graph = new MemoryGraph();
    const selectedPolicy = await policy();
    const service = new ReservationSemanticEvidenceService({
        config: { enabled: true, mode: "shadow", policyFamilyKey: selectedPolicy.familyKey, demoMode: true,
            maxAgeSeconds: 900, artifactRoot: "unused" },
        institutional: { async getActorContext() { return options.actor ?? context(); } }, database,
        availability: { async hasApprovedConflict() { return options.approved ?? false; }, async hasActorConflict() { return options.actorConflict ?? false; } },
        policies: { async resolveActive() { return selectedPolicy; } }, provider: new PyShaclValidationProvider(), graph,
        baseUri: BASE, now: () => new Date(NOW), newUuid: () => RUN,
    });
    return { service, database, graph };
}

test("positive cross-domain evidence executes real pySHACL, remains preview-only, then links an explicit pending request snapshot", async () => {
    const { service, database, graph } = await runtime();
    const result = await service.evaluate({ actorKey: "TEST-ACTOR-STUDENT-001", assetId: 9, start: START, end: END });
    assert.equal(result.semanticEligibility.outcome, "eligible");
    assert.equal(result.availability.status, "available");
    assert.equal(result.operationalEffect.reservationCreated, false);
    assert.equal(database.links.length, 0, "evidence preview does not create or link a reservation");
    assert.equal(graph.graphs.size, 2, "evidence and policy report use separate immutable graphs");
    const evidenceTurtle = graph.graphs.get(result.evidenceGraph.uri) ?? "";
    assert.doesNotMatch(evidenceTurtle, /TEST-ACTOR|studentNumber|Synthetic research group|Doctoral student/,
        "minimal evidence graph excludes actor keys, personal labels and student identifiers");
    await service.assertMatchesAndLink({ runUuid: RUN, actorKey: "TEST-ACTOR-STUDENT-001", assetId: 9,
        start: new Date(START), end: new Date(END), reservationId: 88 });
    assert.deepEqual(database.links[0], { runId: 7, reservationId: 88, snapshotSha256: result.evidenceGraph.sha256 });
});

test("semantic eligible and SQL conflict remain visibly separate authorities", async () => {
    const { service } = await runtime({ actorConflict: true });
    const result = await service.evaluate({ actorKey: "TEST-ACTOR-STUDENT-001", assetId: 9, start: START, end: END });
    assert.equal(result.semanticEligibility.outcome, "eligible");
    assert.equal(result.availability.authority, "sql");
    assert.equal(result.availability.status, "conflict");
    assert.equal(result.availability.conflicts[0]?.kind, "actor_overlap");
});

test("revoked actor changes real policy outcome without creating or blocking a reservation", async () => {
    const { service, database } = await runtime({ actor: context("revoked") });
    const result = await service.evaluate({ actorKey: "TEST-ACTOR-REVOKED-001", assetId: 9, start: START, end: END });
    assert.equal(result.actorEvidence.linkStatus, "revoked");
    assert.equal(result.semanticEligibility.outcome, "not_eligible");
    assert.equal(result.availability.status, "available");
    assert.equal(database.links.length, 0);
});

test("missing structural evidence is indeterminate and a mismatched or expired snapshot is rejected", async () => {
    const missing = resourceRow({ structural_validation_run_id: null, structural_validation_run_uuid: null,
        structural_conforms: null, shapes_artifact_id: null, shapes_version: null });
    const { service } = await runtime({ resource: missing });
    const result = await service.evaluate({ actorKey: "TEST-ACTOR-STUDENT-001", assetId: 9, start: START, end: END });
    assert.equal(result.structuralEvidence.status, "missing");
    assert.equal(result.semanticEligibility.outcome, "indeterminate");
    await assert.rejects(service.assertMatchesAndLink({ runUuid: RUN, actorKey: "TEST-ACTOR-STUDENT-001", assetId: 10,
        start: new Date(START), end: new Date(END) }), /do not match/);
});
