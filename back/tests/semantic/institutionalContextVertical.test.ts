import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { handleActorContext } from "../../routes/institutional.ts";
import { formatInstitutionalContext } from "../../scripts/institutionalContextDemo.ts";
import { ActorInstitutionalLinkService } from "../../semantic/actorInstitutionalLinkService.ts";
import { InstitutionalContextService } from "../../semantic/institutionalContextService.ts";
import { FakeActorInstitutionalLinkDatabase, FakeInstitutionalGraphProvider, FakeInstitutionalVerifier, uuidSequence } from "../helpers/fakeInstitutional.ts";

test("vertical demonstrator: active artifacts → verified SQL link → graph evidence → serialized API and CLI", async () => {
    const studentUri = "https://example.org/uminho-phd/test/institutional/TestStudentPhD001";
    const database = new FakeActorInstitutionalLinkDatabase();
    const verifier = new FakeInstitutionalVerifier(); verifier.agents.add(studentUri);
    const links = new ActorInstitutionalLinkService(database, verifier, {
        newUuid: uuidSequence(), now: () => new Date("2026-07-20T12:00:00.000Z"),
    });
    await links.createVerifiedLink({
        actorKey: "TEST-ACTOR-STUDENT-001", institutionalAgentUri: studentUri, verificationSource: "synthetic_demo_seed",
    });
    const graph = new FakeInstitutionalGraphProvider();
    const service = new InstitutionalContextService(links, graph, { info() {}, error() {} });
    const capture = { status: 0, body: undefined as any };
    const response = {
        status(code: number) { capture.status = code; return response; },
        json(body: unknown) { capture.body = body; return response; },
    } as unknown as Response;
    await handleActorContext(
        { params: { actorKey: "TEST-ACTOR-STUDENT-001" } } as unknown as Request,
        response,
        { config: { graphEnabled: true, demoMode: true, ontologyFamilyKey: "ontology", datasetFamilyKey: "dataset", bridgeFamilyKey: "bridge" }, getContextService: () => service }
    );

    assert.equal(capture.status, 200);
    const context = capture.body.data;
    assert.equal(context.person.label, "TEST Student PhD 001");
    assert.equal(context.memberships[0].organization.label, "TEST Research Group 001");
    assert.equal(context.roles.length, 2);
    assert.equal(context.supervisors[0].label, "TEST Professor 001");
    assert.equal(context.artifactContext.datasetVersion, "1.1.0");
    const text = formatInstitutionalContext(context);
    assert.match(text, /Institutional context/);
    assert.match(text, /Actor is not authenticated/);
    assert.doesNotMatch(text, /SELECT|GRAPH <|password|authorization granted/i);
});
