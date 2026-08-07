/**
 * Model-intake preview classification (ADR-0052): identity by GlobalId, inventory code
 * from IfcSpace.Name. Covers the same-GlobalId code-change collision, the invalid-GlobalId
 * case, the missing-Name case, the duplicate-GlobalId status, precedence, and stable
 * machine-readable codes without SQL/stack leakage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL } from "../helpers/fakeDb.ts";

installFakeMySQL();
const { classifyPreviewSpaceIdentity } = await import("../../modelIntake/modelIntakeService.ts");

const G1 = "3VKKG6_QDBqgUlHMH5Q4EB";
const G2 = "2TYxeEXST7MP9bl8QCa9Ti";

test("A: same GlobalId + changed inventory code (free) → existing space, inventoryCodeChanged=true", () => {
    const r = classifyPreviewSpaceIdentity({
        guid: G1, inventoryCode: "T-NEW", namePresent: true, duplicateGuid: false,
        existingByGlobalId: { id: 55, space_uuid: "u-55", inventory_code_normalized: "T-OLD" },
        inventoryCodeOwner: null,
    });
    assert.equal(r.persistentSpaceStatus, "existing");
    assert.equal(r.blockingCode, "existing");
    assert.equal(r.inventoryCodeChanged, true);
    assert.equal(r.existingInventoryCode, "T-OLD");
    assert.equal(r.blockingError, null);
});

test("A': same GlobalId + same inventory code → existing, inventoryCodeChanged=false", () => {
    const r = classifyPreviewSpaceIdentity({
        guid: G1, inventoryCode: "T-1", namePresent: true, duplicateGuid: false,
        existingByGlobalId: { id: 55, space_uuid: "u-55", inventory_code_normalized: "T-1" },
        inventoryCodeOwner: null,
    });
    assert.equal(r.persistentSpaceStatus, "existing");
    assert.equal(r.inventoryCodeChanged, false);
});

test("existing GlobalId changing code to one owned by another space → inventory_code_collision", () => {
    const r = classifyPreviewSpaceIdentity({
        guid: G1, inventoryCode: "T-NEW", namePresent: true, duplicateGuid: false,
        existingByGlobalId: { id: 55, space_uuid: "u-55", inventory_code_normalized: "T-OLD" },
        inventoryCodeOwner: { id: 66 },
    });
    assert.equal(r.persistentSpaceStatus, "inventory_code_collision");
    assert.equal(r.blockingCode, "inventory_code_collision");
    assert.match(r.blockingError ?? "", /id 66/);
    assert.equal(r.inventoryCodeChanged, true);
});

test("B: different GlobalId + same inventory code → inventory_code_collision (blocking)", () => {
    const r = classifyPreviewSpaceIdentity({
        guid: G2, inventoryCode: "T-1", namePresent: true, duplicateGuid: false,
        existingByGlobalId: null, inventoryCodeOwner: { id: 99 },
    });
    assert.equal(r.persistentSpaceStatus, "inventory_code_collision");
    assert.equal(r.blockingCode, "inventory_code_collision");
    assert.match(r.blockingError ?? "", /id 99/);
    assert.match(r.blockingError ?? "", /uq_spaces_scope_code/);
});

test("C: new GlobalId, free inventory code → new persistent space", () => {
    const r = classifyPreviewSpaceIdentity({
        guid: G2, inventoryCode: "T-FRESH", namePresent: true, duplicateGuid: false,
        existingByGlobalId: null, inventoryCodeOwner: null,
    });
    assert.equal(r.persistentSpaceStatus, "new");
    assert.equal(r.blockingCode, "new");
    assert.equal(r.blockingError, null);
});

test("duplicate GlobalId within the version → invalid (duplicate_candidate_globalid), independent of Name", () => {
    const r = classifyPreviewSpaceIdentity({
        guid: G1, inventoryCode: "T-1", namePresent: true, duplicateGuid: true,
        existingByGlobalId: null, inventoryCodeOwner: null,
    });
    assert.equal(r.persistentSpaceStatus, "invalid");
    assert.equal(r.blockingCode, "duplicate_candidate_globalid");
    assert.match(r.blockingError ?? "", new RegExp(G1));
});

test("malformed GlobalId → invalid (invalid_globalid), classified before any lookup", () => {
    for (const bad of ["", "   ", ` ${G1} `, G1.slice(0, 21), `${G1}X`, `${G1.slice(0, 21)}!`]) {
        const r = classifyPreviewSpaceIdentity({
            guid: bad, inventoryCode: "T-1", namePresent: true, duplicateGuid: false,
            existingByGlobalId: null, inventoryCodeOwner: null,
        });
        assert.equal(r.persistentSpaceStatus, "invalid", `form: ${JSON.stringify(bad)}`);
        assert.equal(r.blockingCode, "invalid_globalid");
    }
});

test("valid GlobalId + missing Name → missing_name (visible, blocking)", () => {
    const r = classifyPreviewSpaceIdentity({
        guid: G1, inventoryCode: "", namePresent: false, duplicateGuid: false,
        existingByGlobalId: null, inventoryCodeOwner: null,
    });
    assert.equal(r.persistentSpaceStatus, "missing_name");
    assert.equal(r.blockingCode, "missing_space_name");
    assert.match(r.blockingError ?? "", /IfcSpace\.Name/);
});

test("precedence: invalid GlobalId + missing Name → invalid_globalid wins", () => {
    const r = classifyPreviewSpaceIdentity({
        guid: "not-valid", inventoryCode: "", namePresent: false, duplicateGuid: false,
        existingByGlobalId: null, inventoryCodeOwner: null,
    });
    assert.equal(r.blockingCode, "invalid_globalid");
});

test("whitespace-only Name is treated as missing", () => {
    // The caller derives namePresent from a trim; a whitespace-only Name yields
    // namePresent=false. Classification then reports missing_space_name.
    const r = classifyPreviewSpaceIdentity({
        guid: G1, inventoryCode: "", namePresent: false, duplicateGuid: false,
        existingByGlobalId: null, inventoryCodeOwner: null,
    });
    assert.equal(r.blockingCode, "missing_space_name");
});

test("preview error messages never leak SQL or stack traces", () => {
    const collision = classifyPreviewSpaceIdentity({
        guid: G2, inventoryCode: "T-1", namePresent: true, duplicateGuid: false,
        existingByGlobalId: null, inventoryCodeOwner: { id: 99 },
    });
    assert.doesNotMatch(collision.blockingError ?? "", /SELECT|INSERT|UPDATE|\bat \w+\.|\.ts:/i);
});
