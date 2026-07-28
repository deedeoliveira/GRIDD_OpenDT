import assert from "node:assert/strict";
import test from "node:test";
import { classifyOutcome } from "../../scripts/migrations/selfTestOutcome.ts";

test("no errors -> success", () => {
  assert.deepEqual(classifyOutcome({ primaryErrorPresent: false, cleanupErrorCount: 0 }), { success: true, failureReason: "none" });
});

test("primary error only -> failure", () => {
  assert.deepEqual(classifyOutcome({ primaryErrorPresent: true, cleanupErrorCount: 0 }), { success: false, failureReason: "primary" });
});

test("cleanup error only -> failure (an undropped schema can never exit successfully)", () => {
  assert.deepEqual(classifyOutcome({ primaryErrorPresent: false, cleanupErrorCount: 1 }), { success: false, failureReason: "cleanup" });
});

test("primary plus cleanup errors -> failure preserving both categories", () => {
  assert.deepEqual(classifyOutcome({ primaryErrorPresent: true, cleanupErrorCount: 2 }), { success: false, failureReason: "primary+cleanup" });
});
