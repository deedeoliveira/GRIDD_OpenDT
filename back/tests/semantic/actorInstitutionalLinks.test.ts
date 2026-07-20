import assert from "node:assert/strict";
import test from "node:test";
import { ActorInstitutionalLinkService } from "../../semantic/actorInstitutionalLinkService.ts";
import { ActorInstitutionalLinkError, normalizeActorKey, sanitizedLinkError } from "../../semantic/actorInstitutionalLinkTypes.ts";
import { seedSyntheticActorLinks } from "../../semantic/syntheticActorLinkSeed.ts";
import { FakeActorInstitutionalLinkDatabase, FakeInstitutionalVerifier, uuidSequence } from "../helpers/fakeInstitutional.ts";

const STUDENT1 = "https://example.org/uminho-phd/test/institutional/TestStudentPhD001";
const STUDENT2 = "https://example.org/uminho-phd/test/institutional/TestStudentPhD002";

function setup(now = new Date("2026-07-20T12:00:00.000Z")) {
    const database = new FakeActorInstitutionalLinkDatabase();
    const verifier = new FakeInstitutionalVerifier();
    verifier.agents.add(STUDENT1); verifier.agents.add(STUDENT2);
    const service = new ActorInstitutionalLinkService(database, verifier, { newUuid: uuidSequence(), now: () => now });
    return { database, verifier, service };
}

test("actor link creates pending then verifies against the exact current dataset", async () => {
    const { service } = setup();
    const pending = await service.createPendingLink({ actorKey: " TEST-ACTOR-STUDENT-001 ", institutionalAgentUri: STUDENT1 });
    assert.equal(pending.status, "pending");
    assert.equal(pending.actor_key, "TEST-ACTOR-STUDENT-001");
    assert.equal(pending.actor_key_normalized, "test-actor-student-001");
    const verified = await service.verifyLink(pending.link_uuid, "synthetic_demo_seed");
    assert.equal(verified.status, "verified");
    assert.equal(verified.institutional_dataset_artifact_id, 40);
});

test("actor-key normalization is trimmed and case-insensitive while preserving original", () => {
    assert.deepEqual(normalizeActorKey("  Test-Actor-01  "), { original: "Test-Actor-01", normalized: "test-actor-01" });
});

test("empty, oversized, and control-character actor keys are rejected", () => {
    for (const value of ["   ", "a".repeat(256), "TEST\u0000ACTOR"]) {
        assert.throws(() => normalizeActorKey(value), (error: unknown) => error instanceof ActorInstitutionalLinkError && error.code === "actor_key_invalid");
    }
});

test("invalid and non-HTTP institutional agent URIs are rejected", async () => {
    const { service } = setup();
    for (const uri of ["not-a-uri", "urn:private:person"]) {
        await assert.rejects(service.createPendingLink({ actorKey: "TEST-ACTOR", institutionalAgentUri: uri }),
            (error: unknown) => error instanceof ActorInstitutionalLinkError && error.code === "institutional_agent_uri_invalid");
    }
});

test("verification rejects an agent absent from the active synthetic graph", async () => {
    const { service } = setup();
    const pending = await service.createPendingLink({ actorKey: "TEST-ACTOR-MISSING", institutionalAgentUri: "https://example.org/test/Missing" });
    await assert.rejects(service.verifyLink(pending.link_uuid, "synthetic_demo_seed"),
        (error: unknown) => error instanceof ActorInstitutionalLinkError && error.code === "institutional_agent_not_found");
});

test("verification rejects a dataset revision that stopped being current", async () => {
    const { service, verifier } = setup();
    const pending = await service.createPendingLink({ actorKey: "TEST-ACTOR-STUDENT-001", institutionalAgentUri: STUDENT1 });
    verifier.dataset.artifactId = 41;
    await assert.rejects(service.verifyLink(pending.link_uuid, "synthetic_demo_seed"),
        (error: unknown) => error instanceof ActorInstitutionalLinkError && error.code === "actor_link_requires_reverification");
});

test("database revalidation rejects a non-current institutional artifact", async () => {
    const { service, database } = setup();
    const pending = await service.createPendingLink({ actorKey: "TEST-ACTOR-STUDENT-001", institutionalAgentUri: STUDENT1 });
    database.artifactCurrent = false;
    await assert.rejects(service.verifyLink(pending.link_uuid, "synthetic_demo_seed"),
        (error: unknown) => error instanceof ActorInstitutionalLinkError && error.code === "institutional_artifact_not_active");
});

test("verified link is current only inside its temporal validity", async () => {
    const { service } = setup();
    const link = await service.createPendingLink({
        actorKey: "TEST-ACTOR-STUDENT-001", institutionalAgentUri: STUDENT1,
        validFrom: new Date("2026-07-19T00:00:00Z"), validTo: new Date("2026-07-21T00:00:00Z"),
    });
    await service.verifyLink(link.link_uuid, "synthetic_demo_seed");
    assert.equal((await service.getCurrentLinkForActor("test-actor-student-001"))?.link_uuid, link.link_uuid);

    const expired = setup(new Date("2026-07-22T00:00:00Z"));
    expired.database.rows.push({ ...(await service.getLatestLinkForActor("TEST-ACTOR-STUDENT-001"))!, id: 1 });
    assert.equal(await expired.service.getCurrentLinkForActor("TEST-ACTOR-STUDENT-001"), null);
});

test("suspend, revoke and supersede preserve link history", async () => {
    for (const operation of ["suspendLink", "revokeLink", "supersedeCurrentLink"] as const) {
        const { service } = setup();
        const link = await service.createVerifiedLink({ actorKey: "TEST-ACTOR-STUDENT-001", institutionalAgentUri: STUDENT1, verificationSource: "synthetic_demo_seed" });
        const changed = await service[operation](link.link_uuid);
        assert.equal(changed.status, operation === "suspendLink" ? "suspended" : operation === "revokeLink" ? "revoked" : "superseded");
        assert.equal((await service.getLinkHistory("TEST-ACTOR-STUDENT-001")).length, 1);
    }
});

test("superseded history permits a new verified revision without losing the prior link", async () => {
    const { service } = setup();
    const first = await service.createVerifiedLink({ actorKey: "TEST-ACTOR-STUDENT-001", institutionalAgentUri: STUDENT1, verificationSource: "seed" });
    await service.supersedeCurrentLink(first.link_uuid);
    const second = await service.createVerifiedLink({ actorKey: "TEST-ACTOR-STUDENT-001", institutionalAgentUri: STUDENT2, verificationSource: "reverification" });
    assert.notEqual(first.link_uuid, second.link_uuid);
    const history = await service.getLinkHistory("TEST-ACTOR-STUDENT-001");
    assert.deepEqual(history.map((row) => row.status).sort(), ["superseded", "verified"]);
});

test("same payload is idempotent for pending and verified operations", async () => {
    const { service, database } = setup();
    const first = await service.createPendingLink({ actorKey: "TEST-ACTOR-STUDENT-001", institutionalAgentUri: STUDENT1 });
    const second = await service.createPendingLink({ actorKey: "test-actor-student-001", institutionalAgentUri: STUDENT1 });
    assert.equal(first.link_uuid, second.link_uuid);
    const verified = await service.verifyLink(first.link_uuid, "seed");
    assert.equal((await service.verifyLink(first.link_uuid, "seed")).link_uuid, verified.link_uuid);
    assert.equal(database.rows.length, 1);
});

test("divergent payload for an actor with pending/current link returns controlled conflict", async () => {
    const { service } = setup();
    await service.createPendingLink({ actorKey: "TEST-ACTOR-STUDENT-001", institutionalAgentUri: STUDENT1 });
    await assert.rejects(service.createPendingLink({ actorKey: "test-actor-student-001", institutionalAgentUri: STUDENT2 }),
        (error: unknown) => error instanceof ActorInstitutionalLinkError && error.code === "actor_link_conflict");
});

test("concurrent same-payload creation and verification converge to one current verified link", async () => {
    const { service, database } = setup();
    const pending = await Promise.all(Array.from({ length: 5 }, () => service.createPendingLink({ actorKey: "TEST-ACTOR-STUDENT-001", institutionalAgentUri: STUDENT1 })));
    assert.equal(new Set(pending.map((row) => row.link_uuid)).size, 1);
    await Promise.all(Array.from({ length: 5 }, () => service.verifyLink(pending[0]!.link_uuid, "seed")));
    assert.equal(database.rows.filter((row) => row.status === "verified").length, 1);
});

test("concurrent divergent creation has one winner and one controlled loser", async () => {
    const { service, database } = setup();
    const outcomes = await Promise.allSettled([
        service.createPendingLink({ actorKey: "TEST-ACTOR-STUDENT-001", institutionalAgentUri: STUDENT1 }),
        service.createPendingLink({ actorKey: "TEST-ACTOR-STUDENT-001", institutionalAgentUri: STUDENT2 }),
    ]);
    assert.equal(outcomes.filter((value) => value.status === "fulfilled").length, 1);
    assert.equal(database.rows.length, 1);
});

test("synthetic seed dry-run is side-effect free and real seed is idempotent including revoked scenario", async () => {
    const { service, database, verifier } = setup();
    for (const uri of [
        "https://example.org/uminho-phd/test/institutional/TestProfessor001",
        "https://example.org/uminho-phd/test/institutional/TestResearcher001",
    ]) verifier.agents.add(uri);
    const dry = await seedSyntheticActorLinks(service, { dryRun: true });
    assert.equal(dry.length, 4); assert.equal(database.rows.length, 0);
    await seedSyntheticActorLinks(service, { dryRun: false });
    await seedSyntheticActorLinks(service, { dryRun: false });
    assert.equal(database.rows.length, 4);
    assert.equal(database.rows.find((row) => row.actor_key === "TEST-ACTOR-REVOKED-001")?.status, "revoked");
});

test("unexpected errors are sanitized without SQL, SPARQL, credentials or stack", () => {
    const sanitized = sanitizedLinkError(new Error("SELECT secret FROM users password=abc"));
    assert.deepEqual(sanitized, { code: "institutional_internal_error", message: "Institutional context operation failed" });
});
