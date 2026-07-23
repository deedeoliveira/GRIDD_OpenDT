import { test } from "node:test";
import assert from "node:assert/strict";
import { OperationalReservabilityEvaluator } from "../../policies/operationalReservabilityEvaluator.ts";
import { LegacyIfcReservabilityEvaluator } from "../../policies/legacyIfcReservabilityEvaluator.ts";

const evaluator = new OperationalReservabilityEvaluator();
const completeNonModelled = () => ({
    candidateKind: "non_modelled_asset" as const,
    entityType: "element" as const,
    name: "Projector",
    assetType: "PortableProjector",
    resourceKind: "equipment",
    source: "graph",
    isOperationalSource: true,
    hasCurrentLocation: true,
    persistentIdentityStatus: "valid" as const,
    lifecycleStatus: "active" as const,
    operationalEvidenceStatus: "verified" as const,
    semanticOperationStatus: "completed" as const,
    sqlProjectionStatus: "coherent" as const,
});

test("non-modelled complete and active is allowed without IFC manifestation or binding", async () => {
    const result = await evaluator.evaluate(completeNonModelled(), { evaluationPhase: "operational" });
    assert.equal(result.decision, "allow");
});

test("missing required operational location is denied, not made indeterminate by IFC absence", async () => {
    const result = await evaluator.evaluate({ ...completeNonModelled(), hasCurrentLocation: false }, { evaluationPhase: "operational" });
    assert.equal(result.decision, "deny");
    assert.match(result.reasons[0]!, /location/i);
});

test("failed semantic synchronization is denied", async () => {
    const result = await evaluator.evaluate({ ...completeNonModelled(), semanticOperationStatus: "failed" }, { evaluationPhase: "operational" });
    assert.equal(result.decision, "deny");
});

test("inactive or retired lifecycle is denied", async () => {
    for (const lifecycleStatus of ["inactive", "retired"] as const) {
        const result = await evaluator.evaluate({ ...completeNonModelled(), lifecycleStatus }, { evaluationPhase: "operational" });
        assert.equal(result.decision, "deny");
    }
});

test("unavailable operational authority remains fail-closed as undetermined", async () => {
    const result = await evaluator.evaluate({ ...completeNonModelled(), operationalEvidenceStatus: "unavailable" }, { evaluationPhase: "operational" });
    assert.equal(result.decision, "undetermined");
});

test("modelled IFC candidates retain the legacy baseline decisions", async () => {
    const legacy = new LegacyIfcReservabilityEvaluator();
    for (const candidate of [
        { guid: "space", entityType: "space" as const, ifcType: "IfcSpace" },
        { guid: "sensor", entityType: "element" as const, ifcType: "IfcSensor" },
        { guid: "desk", entityType: "element" as const, ifcType: "IfcFurniture" },
    ]) {
        const expected = await legacy.evaluate(candidate, {});
        const actual = await evaluator.evaluate(candidate, {});
        assert.equal(actual.decision, expected.decision);
    }
});

test("the operational profile has no DEMO-code exception", async () => {
    const demo = await evaluator.evaluate({ ...completeNonModelled(), managerCode: "DEMO-NM-PROJ-001" }, { evaluationPhase: "operational" });
    const ordinary = await evaluator.evaluate({ ...completeNonModelled(), managerCode: "LAB-PROJ-017" }, { evaluationPhase: "operational" });
    assert.equal(demo.decision, ordinary.decision);
    assert.equal(demo.reasons[0], ordinary.reasons[0]);
});
