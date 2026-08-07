/**
 * IFC4x3-only profile gate (ADR-0052 §A) — the Node side of the schema rule, mirroring
 * the Python classify_ifc_schema. Accepts the IFC4x3 family; rejects IFC2X3 and IFC4 with
 * an explicit unsupported result. The IFC4X3 prefix must be tested BEFORE any bare IFC4.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIfcSchema, isSupportedIfc4x3Schema, evaluateIfcSchemaGate } from "../../utils/ifcSchemaSupport.ts";

test("the IFC4x3 family is supported", () => {
    for (const ident of ["IFC4X3", "IFC4X3_ADD1", "IFC4X3_ADD2", "IFC4X3_TC1", "ifc4x3_add2"]) {
        assert.equal(classifyIfcSchema(ident), "supported", ident);
        assert.ok(isSupportedIfc4x3Schema(ident), ident);
        assert.equal(evaluateIfcSchemaGate(ident).supported, true, ident);
        assert.equal(evaluateIfcSchemaGate(ident).code, null, ident);
    }
});

test("IFC4 is rejected explicitly (and NOT mistaken for IFC4x3)", () => {
    for (const ident of ["IFC4", "IFC4_ADD1", "IFC4_ADD2"]) {
        assert.equal(classifyIfcSchema(ident), "unsupported_ifc4", ident);
        assert.ok(!isSupportedIfc4x3Schema(ident), ident);
        const gate = evaluateIfcSchemaGate(ident);
        assert.equal(gate.supported, false);
        assert.equal(gate.code, "unsupported_ifc_schema");
        assert.match(gate.message ?? "", /IFC4 is not supported/);
    }
});

test("IFC2X3 is rejected explicitly", () => {
    assert.equal(classifyIfcSchema("IFC2X3"), "unsupported_ifc2x3");
    assert.equal(evaluateIfcSchemaGate("IFC2X3").code, "unsupported_ifc_schema");
});

test("unknown / blank / other schemas are rejected, never accepted", () => {
    assert.equal(classifyIfcSchema(null), "unknown");
    assert.equal(classifyIfcSchema(undefined), "unknown");
    assert.equal(classifyIfcSchema("   "), "unknown");
    assert.equal(classifyIfcSchema("SOMETHING"), "unsupported_other");
    for (const v of [null, undefined, "   ", "SOMETHING"]) {
        assert.ok(!isSupportedIfc4x3Schema(v as any));
        assert.equal(evaluateIfcSchemaGate(v as any).supported, false);
    }
});

test("the prefix ordering is correct: IFC4X3 wins over the IFC4 prefix", () => {
    // "IFC4X3".startsWith("IFC4") is true; the rule must classify it as supported.
    assert.equal(classifyIfcSchema("IFC4X3_ADD2"), "supported");
    assert.notEqual(classifyIfcSchema("IFC4X3_ADD2"), "unsupported_ifc4");
});

test("precise allowlist: invented IFC4X3_* variants are rejected (not silently accepted, not mislabelled IFC4)", () => {
    for (const bad of ["IFC4X3_FAKE", "IFC4X3_ATTACK", "IFC4X3_ADD3", "IFC4X3X", "IFC4X3_"]) {
        assert.equal(classifyIfcSchema(bad), "unsupported_other", bad);
        assert.ok(!isSupportedIfc4x3Schema(bad), bad);
        assert.equal(evaluateIfcSchemaGate(bad).supported, false, bad);
        assert.equal(evaluateIfcSchemaGate(bad).code, "unsupported_ifc_schema", bad);
    }
    // Pre-release RC forms are NOT accepted: IfcOpenShell 0.8 cannot parse them, so they
    // must fail closed at the gate exactly like any other unsupported IFC4X3_* variant.
    for (const rc of ["IFC4X3_RC1", "IFC4X3_RC4", "IFC4X3_RCX"]) {
        assert.equal(classifyIfcSchema(rc), "unsupported_other", rc);
        assert.ok(!isSupportedIfc4x3Schema(rc), rc);
        assert.equal(evaluateIfcSchemaGate(rc).code, "unsupported_ifc_schema", rc);
    }
});

test("the gate message explicitly requires IFC4x3", () => {
    const gate = evaluateIfcSchemaGate("IFC4");
    assert.match(gate.message ?? "", /IFC4x3/);
});
