import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Parser } from "n3";
import { validateShapesTurtleSecurity } from "../../semanticValidation/shapeSetService.ts";
import { semanticValidationReportGraphUri } from "../../graph/namedGraphs.ts";

const root = path.resolve(process.cwd(), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "semantic/artifacts/semantic-artifacts-public-manifest.json"), "utf8"));

test("governed model shapes are immutable, public, graph-backed, activatable, parseable, and versioned independently", () => {
    const entry = manifest.artifacts.find((item: any) => item.artifactKey === "oswadt-model-rdf-structural-shapes-1.0.0");
    assert.ok(entry);
    assert.equal(entry.artifactType, "shacl_shapes");
    assert.equal(entry.storageMode, "graph_backed");
    assert.equal(entry.privacyClassification, "public_research_artifact");
    assert.equal(entry.activationAllowed, true);
    assert.equal(entry.testOnly, false);
    assert.equal(entry.semanticVersion, "1.0.0");
    const bytes = fs.readFileSync(path.join(root, "semantic/artifacts", entry.relativePath));
    assert.equal(bytes.length, entry.byteSize);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), entry.sha256);
    assert.equal(new Parser().parse(bytes.toString("utf8")).length, entry.tripleCount);
});

test("temporary shapes security rejects imports, named graphs, and model predicates outside the allowlist", () => {
    assert.throws(() => validateShapesTurtleSecurity(`@prefix owl:<http://www.w3.org/2002/07/owl#>.
      <urn:s> owl:imports <https://external.example/shapes> .`, true), /imports/);
    assert.throws(() => validateShapesTurtleSecurity(`@prefix sh:<http://www.w3.org/ns/shacl#>.
      <urn:g> { <urn:s> a sh:NodeShape . }`, true), /graph URI/);
    assert.throws(() => validateShapesTurtleSecurity(`@prefix sh:<http://www.w3.org/ns/shacl#>.
      <urn:s> a sh:NodeShape ; <https://external.example/predicate> <urn:o> .`, true), /namespace allowlist/);
});

test("temporary upload handling enforces filename, size, real path, symlink guard, and route cleanup", () => {
    const service = fs.readFileSync(path.join(root, "back/semanticValidation/shapeSetService.ts"), "utf8");
    const route = fs.readFileSync(path.join(root, "back/routes/modelIntake.ts"), "utf8");
    assert.match(service, /name !== path\.basename\(name\)/);
    assert.match(service, /file\.size > config\.maxShapesBytes/);
    assert.match(service, /fs\.realpathSync\(file\.path\)/);
    assert.match(service, /isSymbolicLink\(\)/);
    assert.match(route, /finally \{ removeUploadedFiles\(req\); \}/);
    for (const field of ["graphUri", "dataGraphUri", "path", "url", "sparql", "query", "command"]) {
        assert.ok(route.includes(`\"${field}\"`));
    }
});

test("validation report graph URI is internal, run-specific, immutable by construction, and never current/latest", () => {
    const one = semanticValidationReportGraphUri("http://oswadt.test/id", "11111111-1111-4111-8111-111111111111");
    const two = semanticValidationReportGraphUri("http://oswadt.test/id", "22222222-2222-4222-8222-222222222222");
    assert.equal(one, "http://oswadt.test/id/graph/validation/report/11111111-1111-4111-8111-111111111111");
    assert.notEqual(one, two);
    assert.doesNotMatch(one, /current|latest/);
});

test("forward and rollback migrations persist normalized evidence without RDF payloads or destructive graph operations", () => {
    const forward = fs.readFileSync(path.join(root, "database/migrations/2026-07-21_semantic_validation_runs.sql"), "utf8");
    const rollback = fs.readFileSync(path.join(root, "database/migrations/2026-07-21_semantic_validation_runs_rollback.sql"), "utf8");
    assert.match(forward, /CREATE TABLE `semantic_validation_runs`/);
    assert.match(forward, /CREATE TABLE `semantic_validation_results`/);
    assert.match(forward, /focus_node/); assert.match(forward, /constraint_component/); assert.match(forward, /report_graph_uri/);
    assert.doesNotMatch(forward, /rdf_payload|turtle_payload/i);
    assert.match(rollback, /DROP TABLE IF EXISTS `semantic_validation_results`/);
    assert.match(rollback, /DROP TABLE IF EXISTS `semantic_validation_runs`/);
    assert.doesNotMatch(`${forward}\n${rollback}`, /CLEAR|DROP\s+(ALL|NAMED|DEFAULT)/i);
});

test("dashboard renders backend constraints and results without direct Python, Fuseki, SPARQL, or hardcoded SHACL outcomes", () => {
    const source = fs.readFileSync(path.join(root, "front/app/(admin)/dashboard/page.tsx"), "utf8");
    assert.match(source, /shacl\/inspect/); assert.match(source, /shacl\/validate/);
    assert.match(source, /short\(c\.path\)/); assert.match(source, /r\.focusNode/); assert.match(source, /r\.message/);
    assert.doesNotMatch(source, /python\/shacl|3030|SPARQL/i);
    assert.doesNotMatch(source, /SHACL PASS|SHACL FAIL/);
});
