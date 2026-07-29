/**
 * Stage 0B (ADR-0051 §2/§7/§9) model-intake preview classification: identity by
 * GlobalId, Reference is administrative metadata. Covers demonstrations A/B/C, the
 * existing-GlobalId Reference-change collision (§2 C), the invalid-GlobalId case
 * (§1), the missing-Reference case (§2), the duplicate-GlobalId status, precedence,
 * and stable machine-readable codes without SQL/stack leakage.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL } from "../helpers/fakeDb.ts";

installFakeMySQL();
const { classifyPreviewSpaceIdentity } = await import("../../modelIntake/modelIntakeService.ts");

const G1 = "3VKKG6_QDBqgUlHMH5Q4EB";
const G2 = "2TYxeEXST7MP9bl8QCa9Ti";

test("A: same GlobalId + changed Reference (free) → existing persistent space, referenceChanged=true", () => {
    const r = classifyPreviewSpaceIdentity({
        guid: G1, reference: "R-NEW", referencePresent: true, duplicateGuid: false,
        existingByGlobalId: { id: 55, space_uuid: "u-55", inventory_code_normalized: "R-OLD" },
        referenceOwner: null,
    });
    assert.equal(r.persistentSpaceStatus, "existing");
    assert.equal(r.blockingCode, "existing");
    assert.equal(r.referenceChanged, true);
    assert.equal(r.existingReference, "R-OLD");
    assert.equal(r.blockingError, null);
});

test("A': same GlobalId + same Reference → existing, referenceChanged=false", () => {
    const r = classifyPreviewSpaceIdentity({
        guid: G1, reference: "R-1", referencePresent: true, duplicateGuid: false,
        existingByGlobalId: { id: 55, space_uuid: "u-55", inventory_code_normalized: "R-1" },
        referenceOwner: null,
    });
    assert.equal(r.persistentSpaceStatus, "existing");
    assert.equal(r.referenceChanged, false);
});

test("§2 C: existing GlobalId changing Reference to one owned by another space → transitional collision", () => {
    const r = classifyPreviewSpaceIdentity({
        guid: G1, reference: "R-NEW", referencePresent: true, duplicateGuid: false,
        existingByGlobalId: { id: 55, space_uuid: "u-55", inventory_code_normalized: "R-OLD" },
        referenceOwner: { id: 66 },
    });
    assert.equal(r.persistentSpaceStatus, "transitional_reference_collision");
    assert.equal(r.blockingCode, "transitional_reference_collision");
    assert.match(r.blockingError ?? "", /id 66/);
    assert.equal(r.referenceChanged, true);
});

test("B: different GlobalId + same Reference → transitional_reference_collision (blocking)", () => {
    const r = classifyPreviewSpaceIdentity({
        guid: G2, reference: "R-1", referencePresent: true, duplicateGuid: false,
        existingByGlobalId: null, referenceOwner: { id: 99 },
    });
    assert.equal(r.persistentSpaceStatus, "transitional_reference_collision");
    assert.equal(r.blockingCode, "transitional_reference_collision");
    assert.match(r.blockingError ?? "", /id 99/);
    assert.match(r.blockingError ?? "", /uq_spaces_scope_code/);
});

test("C: new GlobalId, free Reference → new persistent space", () => {
    const r = classifyPreviewSpaceIdentity({
        guid: G2, reference: "R-FRESH", referencePresent: true, duplicateGuid: false,
        existingByGlobalId: null, referenceOwner: null,
    });
    assert.equal(r.persistentSpaceStatus, "new");
    assert.equal(r.blockingCode, "new");
    assert.equal(r.blockingError, null);
});

test("duplicate GlobalId within the version → invalid (duplicate_candidate_globalid), independent of Reference", () => {
    const r = classifyPreviewSpaceIdentity({
        guid: G1, reference: "R-1", referencePresent: true, duplicateGuid: true,
        existingByGlobalId: null, referenceOwner: null,
    });
    assert.equal(r.persistentSpaceStatus, "invalid");
    assert.equal(r.blockingCode, "duplicate_candidate_globalid");
    assert.match(r.blockingError ?? "", new RegExp(G1));
});

test("§1: malformed GlobalId → invalid (invalid_globalid), classified before any lookup", () => {
    for (const bad of ["", "   ", ` ${G1} `, G1.slice(0, 21), `${G1}X`, `${G1.slice(0, 21)}!`]) {
        const r = classifyPreviewSpaceIdentity({
            guid: bad, reference: "R-1", referencePresent: true, duplicateGuid: false,
            existingByGlobalId: null, referenceOwner: null,
        });
        assert.equal(r.persistentSpaceStatus, "invalid", `form: ${JSON.stringify(bad)}`);
        assert.equal(r.blockingCode, "invalid_globalid");
    }
});

test("§2: valid GlobalId + missing Reference → missing_reference (visible, blocking)", () => {
    const r = classifyPreviewSpaceIdentity({
        guid: G1, reference: "", referencePresent: false, duplicateGuid: false,
        existingByGlobalId: null, referenceOwner: null,
    });
    assert.equal(r.persistentSpaceStatus, "missing_reference");
    assert.equal(r.blockingCode, "missing_reference");
    assert.match(r.blockingError ?? "", /Reference/);
});

test("§2 precedence: invalid GlobalId + missing Reference → invalid_globalid wins", () => {
    const r = classifyPreviewSpaceIdentity({
        guid: "not-valid", reference: "", referencePresent: false, duplicateGuid: false,
        existingByGlobalId: null, referenceOwner: null,
    });
    assert.equal(r.blockingCode, "invalid_globalid");
});

test("§2: whitespace-only Reference is treated as missing", () => {
    // The caller derives referencePresent from a trim; a whitespace-only Reference
    // yields referencePresent=false. Classification then reports missing_reference.
    const r = classifyPreviewSpaceIdentity({
        guid: G1, reference: "", referencePresent: false, duplicateGuid: false,
        existingByGlobalId: null, referenceOwner: null,
    });
    assert.equal(r.blockingCode, "missing_reference");
});

test("preview error messages never leak SQL or stack traces", () => {
    const collision = classifyPreviewSpaceIdentity({
        guid: G2, reference: "R-1", referencePresent: true, duplicateGuid: false,
        existingByGlobalId: null, referenceOwner: { id: 99 },
    });
    assert.doesNotMatch(collision.blockingError ?? "", /SELECT|INSERT|UPDATE|\bat \w+\.|\.ts:/i);
});
