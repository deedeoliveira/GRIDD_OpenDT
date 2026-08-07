/**
 * Architecture guard (ADR-0052 §A): the central IFC4x3 gate in back/utils/ifcSchemaSupport.ts
 * must be USED by the real production intake AND upload code — not merely importable. A test
 * that only imports classifyIfcSchema would be insufficient, so this scans the actual
 * production sources and proves:
 *   - modelUploadService imports the gate and calls assertSupportedIfc4x3Schema;
 *   - modelIntakeService imports the gate and calls evaluateIfcSchemaGate;
 *   - neither production path still uses the loose startsWith("IFC4") acceptance;
 *   - the schema classification logic lives ONLY in ifcSchemaSupport.ts (no duplicate rule).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const backDir = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(backDir, rel), "utf-8");

test("modelUploadService imports and calls the central IFC4x3 gate", () => {
    const src = read("services/modelUploadService.ts");
    assert.match(src, /import\s*\{[^}]*assertSupportedIfc4x3Schema[^}]*\}\s*from\s*["']\.\.\/utils\/ifcSchemaSupport\.ts["']/);
    assert.match(src, /assertSupportedIfc4x3Schema\(\s*extracted\.schema\s*\)/, "gate is invoked on the extracted schema");
});

test("modelIntakeService imports and calls the central IFC4x3 gate", () => {
    const src = read("modelIntake/modelIntakeService.ts");
    assert.match(src, /import\s*\{[^}]*evaluateIfcSchemaGate[^}]*\}\s*from\s*["']\.\.\/utils\/ifcSchemaSupport\.ts["']/);
    assert.match(src, /evaluateIfcSchemaGate\(\s*extracted\.schema\s*\)/, "gate is invoked on the extracted schema");
});

test("no production path still accepts via the loose startsWith(\"IFC4\") check", () => {
    for (const rel of ["services/modelUploadService.ts", "modelIntake/modelIntakeService.ts"]) {
        const src = read(rel);
        assert.doesNotMatch(src, /startsWith\(\s*["']IFC4["']\s*\)/, `${rel} must not re-accept bare IFC4`);
        assert.doesNotMatch(src, /supports IFC4 only/i, `${rel} must not claim IFC4-only support`);
    }
});

test("schema classification logic lives only in ifcSchemaSupport.ts (single policy)", () => {
    // The precise allowlist markers must not be duplicated into the service files.
    for (const rel of ["services/modelUploadService.ts", "modelIntake/modelIntakeService.ts"]) {
        const src = read(rel);
        assert.doesNotMatch(src, /IFC4X3_ADD1|IFC4X3_TC1|IFC4X3_RC/, `${rel} must not re-implement the allowlist`);
    }
    const gate = read("utils/ifcSchemaSupport.ts");
    assert.match(gate, /SUPPORTED_IFC4X3_IDENTIFIERS/);
    // The pre-release RC allowlist entry must be gone — RC forms fail closed.
    assert.doesNotMatch(gate, /IFC4X3_RC\[0-9\]\+/);
    assert.doesNotMatch(gate, /IFC4X3_RC_PATTERN/);
});

test("the IDS executor pins version filtering OFF so all four accepted schemas are governed", () => {
    // ADR-0052 §G durability contract: the IDS 1.0 XSD can only name IFC4X3_ADD2, so the
    // runtime must run IfcTester with should_filter_version=False (entity-based applicability)
    // to govern every accepted IFC4x3 variant, not merely IFC4X3_ADD2.
    const src = read("python/ids_validate.py");
    assert.match(src, /profile\.validate\(\s*model\s*,\s*should_filter_version\s*=\s*False\s*\)/,
        "ids_validate.py must call validate with should_filter_version=False explicitly");
});
