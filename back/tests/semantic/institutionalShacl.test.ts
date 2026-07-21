import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PyShaclValidationProvider } from "../../semanticValidation/pyShaclValidationProvider.ts";

const artifacts = path.resolve(process.cwd(), "../semantic/artifacts");
const ontology = fs.readFileSync(path.join(artifacts, "runtime/uminho-institutional/1.1.0/uminho-institutional-v1.1.ttl"), "utf8");
const shapes = fs.readFileSync(path.join(artifacts, "runtime/uminho-institutional-structural-shapes/1.1.0/uminho-institutional-structural-shapes-v1.1.ttl"), "utf8");
const positive = fs.readFileSync(path.join(artifacts, "runtime/uminho-institutional-synthetic-data/1.1.0/uminho-test-data-positive-v1.1.ttl"), "utf8");
const negative = fs.readFileSync(path.join(artifacts, "test/uminho-institutional-negative-fixture/1.1.0/uminho-test-data-negative-v1.1.ttl"), "utf8");
const provider = new PyShaclValidationProvider();

function validate(fixture: string, correlationId: string) {
    return provider.validate({ dataTurtle: `${ontology}\n${positive}\n${fixture}`, shapesTurtle: shapes,
        inference: "rdfs", advanced: true, metaShacl: true, timeoutMs: 30_000, correlationId });
}

test("institutional ontology, positive synthetic fixture, and immutable governed shapes conform", async () => {
    const report = await validate("", "institutional-positive");
    assert.equal(report.conforms, true);
    assert.equal(report.resultCount, 0);
});

test("institutional negative fixture fails with exactly seven explainable results and remains test-only", async () => {
    const report = await validate(negative, "institutional-negative");
    assert.equal(report.conforms, false);
    assert.equal(report.resultCount, 7);
    assert.ok(report.results.every((result) => result.focusNode && result.sourceConstraintComponent && result.severity));
    const manifest = JSON.parse(fs.readFileSync(path.join(artifacts, "semantic-artifacts-public-manifest.json"), "utf8"));
    const entry = manifest.artifacts.find((item: any) => item.artifactKey === "uminho-institutional-negative-fixture-1.1.0");
    assert.equal(entry.testOnly, true);
    assert.equal(entry.activationAllowed, false);
});
