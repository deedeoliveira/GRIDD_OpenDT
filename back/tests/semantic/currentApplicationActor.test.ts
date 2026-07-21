import assert from "node:assert/strict";
import test from "node:test";
import { assertCurrentApplicationActor, resolveCurrentApplicationActor } from "../../reservation/currentApplicationActor.ts";

test("the current application actor has one configured development source", () => {
    assert.equal(resolveCurrentApplicationActor({ CURRENT_APPLICATION_ACTOR_KEY: "DEV-ACTOR-001" }), "DEV-ACTOR-001");
    assert.equal(assertCurrentApplicationActor("dev-actor-001", { CURRENT_APPLICATION_ACTOR_KEY: "DEV-ACTOR-001" }), "DEV-ACTOR-001");
});

test("a client cannot substitute a different current actor", () => {
    assert.throws(() => assertCurrentApplicationActor("TEST-ACTOR-REVOKED-001", { CURRENT_APPLICATION_ACTOR_KEY: "DEV-ACTOR-001" }),
        (error: any) => error.code === "current_actor_mismatch" && error.httpStatus === 403);
});
