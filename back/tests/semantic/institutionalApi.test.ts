import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { ActorInstitutionalLinkError } from "../../semantic/actorInstitutionalLinkTypes.ts";
import { createInstitutionalRouter, handleActorContext, handleDemoActors, type InstitutionalRouteDependencies } from "../../routes/institutional.ts";
import type { InstitutionalActorContext } from "../../semantic/institutionalTypes.ts";

function responseCapture() {
    const capture = { statusCode: 0, body: undefined as any };
    const response = {
        status(code: number) { capture.statusCode = code; return response; },
        json(body: unknown) { capture.body = body; return response; },
    } as unknown as Response;
    return { capture, response };
}

function request(actorKey = "TEST-ACTOR-STUDENT-001") {
    return { params: { actorKey } } as unknown as Request;
}

const config = { graphEnabled: true, demoMode: true, ontologyFamilyKey: "ontology", datasetFamilyKey: "dataset", bridgeFamilyKey: "bridge" };
const context: InstitutionalActorContext = {
    actorKey: "TEST-ACTOR-STUDENT-001", contextAvailable: true, unavailableReason: null,
    link: { linkUuid: "link-1", status: "verified", linkType: "represents_institutional_actor", validFrom: null, validTo: null, verifiedAt: "2026-07-20T00:00:00.000Z", verificationSource: "synthetic_demo_seed" },
    person: { uri: "https://example.org/test/Student", label: "TEST Student PhD 001", studentNumber: "TEST-STUDENT-001", types: [] },
    memberships: [], roles: [], supervisors: [], artifactContext: null,
    caveats: ["synthetic_demo_data", "actor_key_is_not_authenticated", "not_a_reservation_decision"],
};

function dependencies(result: InstitutionalActorContext | Error, overrides = {}): InstitutionalRouteDependencies {
    return {
        config: { ...config, ...overrides },
        getContextService: () => ({
            getActorContext: async () => { if (result instanceof Error) throw result; return result; },
        }) as any,
    };
}

test("GET actor context serializes a complete context with HTTP 200", async () => {
    const { capture, response } = responseCapture();
    await handleActorContext(request(), response, dependencies(context));
    assert.equal(capture.statusCode, 200);
    assert.equal(capture.body.data.person.studentNumber, "TEST-STUDENT-001");
    assert.equal(capture.body.data.contextAvailable, true);
});

test("GET actor context serializes valid empty supervisors with HTTP 200", async () => {
    const { capture, response } = responseCapture();
    await handleActorContext(request("TEST-ACTOR-STUDENT-002"), response, dependencies({ ...context, actorKey: "TEST-ACTOR-STUDENT-002", supervisors: [] }));
    assert.equal(capture.statusCode, 200);
    assert.deepEqual(capture.body.data.supervisors, []);
});

test("known unavailable/revoked link uses consistent HTTP 200 contract", async () => {
    const { capture, response } = responseCapture();
    await handleActorContext(request("TEST-ACTOR-REVOKED-001"), response, dependencies({
        ...context, actorKey: "TEST-ACTOR-REVOKED-001", contextAvailable: false,
        unavailableReason: "actor_link_revoked", person: null, link: { ...context.link, status: "revoked" },
    }));
    assert.equal(capture.statusCode, 200);
    assert.equal(capture.body.data.unavailableReason, "actor_link_revoked");
});

test("unknown actor is 404 and graph down/timeout are 503/504", async () => {
    for (const [error, expected] of [
        [new ActorInstitutionalLinkError("actor_link_not_found", "not found", 404), 404],
        [new ActorInstitutionalLinkError("institutional_graph_unavailable", "unavailable", 503), 503],
        [new ActorInstitutionalLinkError("institutional_graph_timeout", "timeout", 504), 504],
    ] as const) {
        const { capture, response } = responseCapture();
        await handleActorContext(request(), response, dependencies(error));
        assert.equal(capture.statusCode, expected);
        assert.equal(capture.body.code, error.code);
    }
});

test("invalid actor key is sanitized as a controlled 400", async () => {
    const { capture, response } = responseCapture();
    await handleActorContext(request("bad\u0000key"), response, dependencies(new ActorInstitutionalLinkError("actor_key_invalid", "invalid actor key", 400)));
    assert.equal(capture.statusCode, 400);
    assert.doesNotMatch(JSON.stringify(capture.body), /stack|SQL|SPARQL/);
});

test("feature-disabled route is 503 without constructing the context service", async () => {
    let constructed = false;
    const deps: InstitutionalRouteDependencies = { config: { ...config, graphEnabled: false }, getContextService() { constructed = true; throw new Error("must not happen"); } };
    const { capture, response } = responseCapture();
    await handleActorContext(request(), response, deps);
    assert.equal(capture.statusCode, 503);
    assert.equal(constructed, false);
});

test("demo actors endpoint lists only synthetic presets when enabled", () => {
    const { capture, response } = responseCapture();
    handleDemoActors(request(), response, dependencies(context));
    assert.equal(capture.statusCode, 200);
    assert.deepEqual(capture.body.data.map((item: any) => item.actorKey), ["TEST-ACTOR-STUDENT-001", "TEST-ACTOR-STUDENT-002", "TEST-ACTOR-REVOKED-001"]);
});

test("demo actors endpoint returns indistinct 404 when disabled", () => {
    const { capture, response } = responseCapture();
    handleDemoActors(request(), response, dependencies(context, { demoMode: false }));
    assert.equal(capture.statusCode, 404);
    assert.equal(capture.body.code, "not_found");
});

test("institutional router exposes GET only and no generic query or seed endpoint", () => {
    const router: any = createInstitutionalRouter(dependencies(context));
    const routes = router.stack.filter((layer: any) => layer.route).map((layer: any) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
    }));
    assert.deepEqual(routes, [
        { path: "/actors/:actorKey/context", methods: ["get"] },
        { path: "/demo/actors", methods: ["get"] },
    ]);
    assert.doesNotMatch(JSON.stringify(routes), /query|seed|post|put|patch|delete/i);
});
