import test from "node:test";
import assert from "node:assert/strict";
import {
    institutionalOntologyGraphUri,
    institutionalSyntheticDataGraphUri,
    negativeFixtureGraphUri,
    projectInstitutionalBridgeGraphUri,
    structuralShapesGraphUri,
} from "../../graph/namedGraphs.ts";

const BASE = "https://example.org/id";
const ARTIFACT = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000099";

test("7B1 graph helpers generate one immutable UUID-scoped graph per runtime role", () => {
    assert.equal(institutionalOntologyGraphUri(BASE, ARTIFACT), `${BASE}/graph/vocabularies/institutional-ontology/${ARTIFACT}`);
    assert.equal(projectInstitutionalBridgeGraphUri(BASE, ARTIFACT), `${BASE}/graph/vocabularies/project-institutional-bridge/${ARTIFACT}`);
    assert.equal(structuralShapesGraphUri(BASE, ARTIFACT), `${BASE}/graph/validation/shapes/${ARTIFACT}`);
    assert.equal(institutionalSyntheticDataGraphUri(BASE, ARTIFACT), `${BASE}/graph/institutional-data/synthetic/${ARTIFACT}`);
});

test("7B1 negative fixture graph is isolated below a unique test-run namespace", () => {
    assert.equal(negativeFixtureGraphUri(BASE, RUN, ARTIFACT), `${BASE}/graph/test/${RUN}/negative/${ARTIFACT}`);
});

test("7B1 graph helpers reject non-UUID artifact identities", () => {
    assert.throws(() => institutionalOntologyGraphUri(BASE, "7"));
});

test("7B1 runtime graph helpers never generate the operational graph", () => {
    const values = [
        institutionalOntologyGraphUri(BASE, ARTIFACT),
        projectInstitutionalBridgeGraphUri(BASE, ARTIFACT),
        structuralShapesGraphUri(BASE, ARTIFACT),
        institutionalSyntheticDataGraphUri(BASE, ARTIFACT),
    ];
    assert.ok(values.every((uri) => !uri.includes("/graph/operational")));
});

test("7B1 graph helpers never generate current, active or latest aliases", () => {
    const values = [
        institutionalOntologyGraphUri(BASE, ARTIFACT),
        projectInstitutionalBridgeGraphUri(BASE, ARTIFACT),
        structuralShapesGraphUri(BASE, ARTIFACT),
        institutionalSyntheticDataGraphUri(BASE, ARTIFACT),
    ];
    assert.ok(values.every((uri) => !/\/(current|active|latest)(\/|$)/.test(uri)));
});
