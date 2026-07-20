import assert from "node:assert/strict";
import test from "node:test";
import { ActorInstitutionalLinkService } from "../../semantic/actorInstitutionalLinkService.ts";
import { InstitutionalContextService, INSTITUTIONAL_CONTEXT_CAVEATS } from "../../semantic/institutionalContextService.ts";
import { FakeActorInstitutionalLinkDatabase, FakeInstitutionalGraphProvider, FakeInstitutionalVerifier, uuidSequence } from "../helpers/fakeInstitutional.ts";

const STUDENT1 = "https://example.org/uminho-phd/test/institutional/TestStudentPhD001";
const STUDENT2 = "https://example.org/uminho-phd/test/institutional/TestStudentPhD002";
const PROFESSOR1 = "https://example.org/uminho-phd/test/institutional/TestProfessor001";
const NOW = new Date("2026-07-20T12:00:00.000Z");

function setup() {
    const database = new FakeActorInstitutionalLinkDatabase();
    const verifier = new FakeInstitutionalVerifier();
    for (const uri of [STUDENT1, STUDENT2, PROFESSOR1]) verifier.agents.add(uri);
    const links = new ActorInstitutionalLinkService(database, verifier, { newUuid: uuidSequence(), now: () => NOW });
    const graph = new FakeInstitutionalGraphProvider();
    const logs: Array<{ event: string; details: Record<string, unknown> }> = [];
    const logger = { info(event: string, details: Record<string, unknown>) { logs.push({ event, details }); }, error(event: string, details: Record<string, unknown>) { logs.push({ event, details }); } };
    const context = new InstitutionalContextService(links, graph, logger, () => NOW);
    return { database, verifier, links, graph, logs, context };
}

async function verified(links: ActorInstitutionalLinkService, actorKey: string, uri: string, validity: { validFrom?: Date; validTo?: Date } = {}) {
    const pending = await links.createPendingLink({ actorKey, institutionalAgentUri: uri, ...validity });
    return links.verifyLink(pending.link_uuid, "synthetic_demo_seed");
}

test("Student 001 resolves person, student number, group roles, supervisor and artifact versions", async () => {
    const { links, context } = setup();
    await verified(links, "TEST-ACTOR-STUDENT-001", STUDENT1);
    const result = await context.getActorContext("TEST-ACTOR-STUDENT-001", "correlation-1");
    assert.equal(result.contextAvailable, true);
    assert.equal(result.person?.label, "TEST Student PhD 001");
    assert.equal(result.person?.studentNumber, "TEST-STUDENT-001");
    assert.equal(result.memberships[0]?.organization.label, "TEST Research Group 001");
    assert.equal(result.roles.length, 2);
    assert.deepEqual(result.supervisors.map((item) => item.label), ["TEST Professor 001"]);
    assert.equal(result.artifactContext?.datasetVersion, "1.1.0");
});

test("Student 002 is valid with roles and an empty supervisor assertion", async () => {
    const { links, context } = setup();
    await verified(links, "TEST-ACTOR-STUDENT-002", STUDENT2);
    const result = await context.getActorContext("TEST-ACTOR-STUDENT-002");
    assert.equal(result.contextAvailable, true);
    assert.equal(result.person?.studentNumber, "TEST-STUDENT-002");
    assert.equal(result.memberships[0]?.organization.label, "TEST Research Cluster 001");
    assert.deepEqual(result.supervisors, []);
    assert.equal(result.unavailableReason, null);
});

test("professor context does not invent a student number", async () => {
    const { links, context } = setup();
    await verified(links, "TEST-ACTOR-PROFESSOR-001", PROFESSOR1);
    const result = await context.getActorContext("TEST-ACTOR-PROFESSOR-001");
    assert.equal(result.contextAvailable, true);
    assert.equal(result.person?.studentNumber, null);
});

test("pending, suspended, revoked and superseded links return controlled unavailable contexts without graph evidence", async () => {
    for (const status of ["pending", "suspended", "revoked", "superseded"] as const) {
        const { links, graph, context } = setup();
        const link = await links.createPendingLink({ actorKey: `TEST-ACTOR-${status}`, institutionalAgentUri: STUDENT1 });
        if (status !== "pending") {
            await links.verifyLink(link.link_uuid, "seed");
            if (status === "suspended") await links.suspendLink(link.link_uuid);
            if (status === "revoked") await links.revokeLink(link.link_uuid);
            if (status === "superseded") await links.supersedeCurrentLink(link.link_uuid);
        }
        const result = await context.getActorContext(`TEST-ACTOR-${status}`);
        assert.equal(result.contextAvailable, false);
        assert.match(result.unavailableReason!, new RegExp(status === "pending" ? "not_verified" : status));
        assert.deepEqual(graph.calls, []);
    }
});

test("expired link is unavailable and never queries the graph", async () => {
    const { links, graph, context } = setup();
    await verified(links, "TEST-ACTOR-EXPIRED", STUDENT1, { validTo: new Date("2026-07-19T00:00:00Z") });
    const result = await context.getActorContext("TEST-ACTOR-EXPIRED");
    assert.equal(result.unavailableReason, "actor_link_expired");
    assert.deepEqual(graph.calls, []);
});

test("link verified against a superseded dataset requires re-verification and does not query person data", async () => {
    const { links, graph, context } = setup();
    await verified(links, "TEST-ACTOR-STUDENT-001", STUDENT1);
    graph.artifactContext.dataset.artifactId = 41;
    graph.artifactContext.datasetArtifactUuid = "00000000-0000-4000-8000-000000000041";
    const result = await context.getActorContext("TEST-ACTOR-STUDENT-001");
    assert.equal(result.contextAvailable, false);
    assert.equal(result.unavailableReason, "actor_link_requires_reverification");
    assert.deepEqual(graph.calls, ["artifacts"]);
});

test("linked agent absent from active graph returns controlled not-found error", async () => {
    const { links, graph, context } = setup();
    const missing = "https://example.org/uminho-phd/test/institutional/TestMissing001";
    graph.people.delete(STUDENT1);
    await verified(links, "TEST-ACTOR-STUDENT-001", STUDENT1);
    await assert.rejects(context.getActorContext("TEST-ACTOR-STUDENT-001"), (error: any) => error.code === "institutional_agent_not_found");
    assert.equal(missing.includes("TestMissing"), true);
});

test("every available and unavailable response carries mandatory scientific caveats", async () => {
    const { links, context } = setup();
    await verified(links, "TEST-ACTOR-STUDENT-001", STUDENT1);
    const available = await context.getActorContext("TEST-ACTOR-STUDENT-001");
    assert.deepEqual(available.caveats, [...INSTITUTIONAL_CONTEXT_CAVEATS]);

    const pending = await links.createPendingLink({ actorKey: "TEST-ACTOR-PENDING", institutionalAgentUri: STUDENT2 });
    assert.equal(pending.status, "pending");
    assert.deepEqual((await context.getActorContext("TEST-ACTOR-PENDING")).caveats, [...INSTITUTIONAL_CONTEXT_CAVEATS]);
});

test("structured observability excludes names, student numbers, SPARQL and graph contents", async () => {
    const { links, logs, context } = setup();
    await verified(links, "TEST-ACTOR-STUDENT-001", STUDENT1);
    await context.getActorContext("TEST-ACTOR-STUDENT-001", "correlation-observable");
    const serialized = JSON.stringify(logs);
    assert.match(serialized, /institutional_actor_link_resolved/);
    assert.match(serialized, /correlation-observable/);
    assert.doesNotMatch(serialized, /TEST Student|TEST-STUDENT|SELECT|GRAPH\s|studentNumber/);
});
