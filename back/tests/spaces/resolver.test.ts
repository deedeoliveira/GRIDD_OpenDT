/**
 * Tests of the IfcSpaceNameInventoryCodeResolver (ADR-0052) — the institutional
 * inventory code comes from IfcSpace.Name, validated with conservative (trim-only)
 * normalization. Pset_SpaceCommon.Reference is never read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { IfcSpaceNameInventoryCodeResolver } from "../../identity/ifcSpaceNameInventoryCodeResolver.ts";

const resolver = new IfcSpaceNameInventoryCodeResolver();
const ctx = { linkedModelId: 1, modelId: 1, modelVersionId: 1 };

function candidate(name: any, psets: any = null) {
    return { guid: "guid-1", name, longName: "Sala Longa", psets };
}

test("the source is IfcSpace.Name, centralized on the resolver", () => {
    assert.equal(IfcSpaceNameInventoryCodeResolver.SOURCE, "IfcSpace.Name");
    assert.equal(IfcSpaceNameInventoryCodeResolver.ID, "ifcspace-name-inventory-code");
});

test("valid Name → valid, with raw + normalized value, source and traceability", async () => {
    const r = await resolver.resolve(candidate("T-101"), ctx);
    assert.equal(r.status, "valid");
    assert.equal(r.rawValue, "T-101");
    assert.equal(r.normalizedValue, "T-101");
    assert.equal(r.source, "IfcSpace.Name");
    assert.equal(r.resolverId, "ifcspace-name-inventory-code");
    assert.ok(!isNaN(Date.parse(r.resolvedAt)));
    assert.equal(r.guid, "guid-1");
});

test("absent Name → missing (blocks intake)", async () => {
    for (const value of [null, undefined]) {
        const r = await resolver.resolve(candidate(value), ctx);
        assert.equal(r.status, "missing");
        assert.equal(r.rawValue, null);
        assert.equal(r.normalizedValue, null);
        assert.ok(r.reasons.length > 0);
    }
});

test("empty / whitespace-only Name → invalid", async () => {
    for (const value of ["", "   "]) {
        const r = await resolver.resolve(candidate(value), ctx);
        assert.equal(r.status, "invalid");
    }
    const r = await resolver.resolve(candidate(""), ctx);
    assert.match(r.reasons[0]!, /empty or whitespace-only/);
});

test("unexpected type (number, boolean, object) → invalid with reason", async () => {
    for (const value of [101, true, { a: 1 }]) {
        const r = await resolver.resolve(candidate(value), ctx);
        assert.equal(r.status, "invalid");
        assert.match(r.reasons[0]!, /unexpected type/);
    }
});

test("conservative normalization: trim only — case, leading zeros and interior preserved", async () => {
    const r = await resolver.resolve(candidate("  t-007 A  "), ctx);
    assert.equal(r.status, "valid");
    assert.equal(r.rawValue, "  t-007 A  ", "original value preserved");
    assert.equal(r.normalizedValue, "t-007 A", "only outer whitespace removed");

    const upper = await resolver.resolve(candidate("T-101"), ctx);
    const lower = await resolver.resolve(candidate("t-101"), ctx);
    assert.notEqual(upper.normalizedValue, lower.normalizedValue);

    const zeros = await resolver.resolve(candidate("007"), ctx);
    assert.equal(zeros.normalizedValue, "007");
});

test("Pset_SpaceCommon.Reference is never read — Name governs even when a Reference is present", async () => {
    const r = await resolver.resolve(candidate("T-102", { Pset_SpaceCommon: { Reference: "R-999-CONFLICT" } }), ctx);
    assert.equal(r.status, "valid");
    assert.equal(r.normalizedValue, "T-102");
    assert.notEqual(r.normalizedValue, "R-999-CONFLICT");
});
