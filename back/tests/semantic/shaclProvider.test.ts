import test from "node:test";
import assert from "node:assert/strict";
import { PyShaclValidationProvider } from "../../semanticValidation/pyShaclValidationProvider.ts";
import { SemanticValidationError } from "../../semanticValidation/semanticValidationTypes.ts";

const provider = new PyShaclValidationProvider();
const data = `@prefix ex: <http://example.test/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:item a ex:Item ; ex:code "A-1" .`;
const shapes = `@prefix ex: <http://example.test/> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
ex:ItemShape a sh:NodeShape ; sh:targetClass ex:Item ;
  sh:property [ sh:path ex:code ; sh:minCount 1 ; sh:maxCount 1 ; sh:datatype <http://www.w3.org/2001/XMLSchema#string> ;
    sh:message "Exactly one code is required." ] .`;

function request(overrides: Record<string, unknown> = {}) {
    return { dataTurtle: data, shapesTurtle: shapes, inference: "none" as const, advanced: true,
        metaShacl: true, timeoutMs: 30_000, correlationId: "provider-test", ...overrides };
}

test("real pySHACL validates actual data and exposes constraints from the received shapes", async () => {
    const report = await provider.validate(request());
    assert.equal(report.executorName, "pySHACL");
    assert.equal(report.executorVersion, "0.40.0");
    assert.equal(report.conforms, true);
    assert.equal(report.resultCount, 0);
    assert.equal(report.constraints.length, 1);
    const constraint = report.constraints[0]!;
    assert.equal(constraint.path, "http://example.test/code");
    assert.equal(constraint.minCount, 1);
    assert.equal(constraint.maxCount, 1);
});

test("real pySHACL normalizes violation focus node, path, value, component, severity, and message", async () => {
    const report = await provider.validate(request({ dataTurtle: `@prefix ex: <http://example.test/> . ex:item a ex:Item .` }));
    assert.equal(report.conforms, false);
    assert.equal(report.resultCount, 1);
    assert.equal(report.results[0].focusNode, "http://example.test/item");
    assert.equal(report.results[0].resultPath, "http://example.test/code");
    assert.match(report.results[0].sourceConstraintComponent ?? "", /MinCountConstraintComponent$/);
    assert.match(report.results[0].severity ?? "", /Violation$/);
    assert.match(report.results[0].message ?? "", /Exactly one code/);
});

test("real pySHACL preserves warning severity without treating it as a passing shortcut", async () => {
    const warningShapes = shapes.replace("sh:message", "sh:severity sh:Warning ; sh:message");
    const report = await provider.validate(request({
        dataTurtle: `@prefix ex: <http://example.test/> . ex:item a ex:Item .`, shapesTurtle: warningShapes,
    }));
    assert.equal(report.conforms, false);
    assert.match(report.results[0].severity ?? "", /Warning$/);
});

test("malformed or meta-SHACL-invalid shapes are rejected with sanitized errors", async () => {
    await assert.rejects(provider.validate(request({ shapesTurtle: "not turtle [" })), (error: any) => {
        assert.ok(error instanceof SemanticValidationError);
        assert.equal(error.code, "shacl_input_rejected");
        assert.doesNotMatch(error.message, /Traceback|File \"/);
        return true;
    });
    const invalidMetaShapes = `@prefix ex: <http://example.test/> . @prefix sh: <http://www.w3.org/ns/shacl#> .
      ex:Bad a sh:NodeShape ; sh:targetClass ex:Item ; sh:property [ sh:path 42 ; sh:minCount 1 ] .`;
    await assert.rejects(provider.validate(request({ shapesTurtle: invalidMetaShapes })), (error: any) => {
        assert.ok(error instanceof SemanticValidationError);
        assert.equal(error.code, "shacl_input_rejected");
        return true;
    });
});

test("provider timeout and cancellation surface only sanitized operational errors", async () => {
    await assert.rejects(provider.validate(request({ timeoutMs: 1 })), (error: any) => {
        assert.ok(error instanceof SemanticValidationError);
        assert.equal(error.code, "shacl_executor_timeout");
        assert.equal(error.message, "SHACL validation timed out.");
        return true;
    });
});
