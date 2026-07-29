/**
 * Space identity service — Stage 0B (ADR-0051): the persistent-space identity
 * authority is linked_model_id + exact case-sensitive IfcSpace.GlobalId. Reference
 * remains extracted/required transitionally but is administrative metadata only.
 * Cases A–N of the Stage 0B contract, plus the full GlobalId validator (§1), the
 * hardened duplicate-key translation (§5), the verified concurrent re-resolution
 * (§6), and reconciliation/compensation (unchanged).
 *
 * GlobalIds here are valid IFC compressed GlobalIds (^[0-9A-Za-z_$]{22}$) because
 * the application now validates the full form before any write.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";
import { schemaRoutes } from "../helpers/spaceSchemaFixtures.ts";

installFakeMySQL();

const {
    persistSpaceIdentities: rawPersistSpaceIdentities, reconcileSpaceStatusesAfterActivation,
    DuplicateSpaceReferenceError, DuplicateSpaceGlobalIdError,
    TransitionalReferenceCollisionError, InvalidSpaceGlobalIdError,
} = await import("../../services/spaceIdentityService.ts");

// The lossless occurrence contract is MANDATORY (ADR-0051 §1-v3). These unit tests
// exercise the DB-resolution path, so they derive occurrences from the candidates —
// one per candidate GlobalId, carrying its entity id — exactly as the orchestrator
// passes them. Tests that specifically probe a bad contract pass `occurrences` directly.
function occFrom(candidates: any[]) {
    return candidates.map((c) => ({ guid: c.guid, name: c.name, longName: c.longName, entityId: c.entityId }));
}
async function persistSpaceIdentities(args: any) {
    return rawPersistSpaceIdentities({ ...args, occurrences: "occurrences" in args ? args.occurrences : occFrom(args.candidates) });
}
const identityProvider = await import("../../identity/spaceIdentityProvider.ts");
const { default: spaceDb, SpaceCanonicalSchemaError, resetCanonicalSchemaCache } =
    await import("../../utils/spaceDatabase.ts");

beforeEach(() => {
    fakeConnection.reset();
    identityProvider.resetSpaceIdentityResolver();
    resetCanonicalSchemaCache();
});

const CTX = { linkedModelId: 10, modelId: 20, modelVersionId: 30 };

// Valid, distinct IFC compressed GlobalIds.
const GA = "3VKKG6_QDBqgUlHMH5Q4EB";
const GB = "2TYxeEXST7MP9bl8QCa9Ti";
const GC = "2TYxeEXST7MP9bl8QCa9Od";
const GD = "1abcdefghijklmnopqrstu";
const GNOREF = "5abcdefghijklmnopqrstu";
const GX = "6abcdefghijklmnopqrstu";
const GY = "7abcdefghijklmnopqrstu";
const GZ = "8abcdefghijklmnopqrstu";
const GCASE_L = "AAAAAAAAAAAAAAAAAAAA1a";
const GCASE_U = "AAAAAAAAAAAAAAAAAAAA1A";

function cand(guid: any, code: string | null, entityId: number, name = "Sala", longName = "Sala Longa") {
    return { guid, name, longName, entityId, psets: code === null ? {} : { Pset_SpaceCommon: { Reference: code } } };
}

const AUTHORITY_SINGLE: [RegExp, any] =
    [/spatial_authority_model_id/i, [[{ spatial_authority_model_id: null, model_count: 1, single_model_id: 20 }]]];
const AUTHORITY_UNDETERMINED: [RegExp, any] =
    [/spatial_authority_model_id/i, [[{ spatial_authority_model_id: null, model_count: 2, single_model_id: 20 }]]];

// Stage 0A EXACT schema precondition + scope integrity (ADR-0051 §3/§4): present & clean.
const NO_NULL_CANONICAL: [RegExp, any] = [/ifc_global_id IS NULL/i, [[]]];
const NO_BINDING_MISMATCH: [RegExp, any] = [/BINARY sb\.ifc_guid <> BINARY s\.ifc_global_id/i, [[]]];
const PRELUDE = [...schemaRoutes(), NO_NULL_CANONICAL, NO_BINDING_MISMATCH];

// Canonical GlobalId lookup (must precede the generic Reference lookup).
const G = /SELECT \* FROM spaces[\s\S]*BINARY ifc_global_id = BINARY/i;
const R = /SELECT \* FROM spaces[\s\S]*inventory_code_normalized/i;

/* ================= A. SAME GLOBALID, SAME REFERENCE ================= */
test("A: same GlobalId + same Reference → reuse the same spaces.id, no INSERT, no Reference update", async () => {
    respond([...PRELUDE, AUTHORITY_SINGLE,
        [G, [[{ id: 55, space_uuid: "uuid-55", inventory_code_normalized: "R-101" }]]],
        [/INSERT INTO space_bindings/i, [{ insertId: 91, affectedRows: 1 }]]]);

    const outcome = await persistSpaceIdentities({ ...CTX, candidates: [cand(GA, "R-101", 700)] });

    assert.equal(outcome.diagnostics.reused_spaces, 1);
    assert.equal(outcome.diagnostics.created_spaces, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/UPDATE spaces\s+SET inventory_code/i).length, 0, "Reference unchanged → no update");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO space_bindings/i)[0]!.params.spaceId, 55);
});

/* ============ B. SAME GLOBALID, CHANGED REFERENCE ============ */
test("B: same GlobalId + changed Reference → same spaces.id reused, current Reference updated, binding snapshot new", async () => {
    respond([...PRELUDE, AUTHORITY_SINGLE,
        [G, [[{ id: 55, space_uuid: "uuid-55", inventory_code_normalized: "R-OLD" }]]],
        [R, [[]]],                                  // new Reference free (no clash)
        [/UPDATE spaces\s+SET inventory_code/i, [{}]],
        [/INSERT INTO space_bindings/i, [{ insertId: 92, affectedRows: 1 }]]]);

    const outcome = await persistSpaceIdentities({ ...CTX, candidates: [cand(GA, "R-NEW", 700)] });

    assert.equal(outcome.diagnostics.reused_spaces, 1);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0, "no new persistent row");
    const upd = fakeConnection.callsMatching(/UPDATE spaces\s+SET inventory_code/i);
    assert.equal(upd.length, 1, "current administrative Reference updated");
    assert.equal(upd[0]!.params.spaceId, 55);
    assert.equal(upd[0]!.params.inventoryCodeNormalized, "R-NEW");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO space_bindings/i)[0]!.params.inventoryCodeSnapshot, "R-NEW");
});

/* ==== B'. SAME GLOBALID, CHANGED REFERENCE OWNED BY ANOTHER SPACE (§2 C) ==== */
test("B': same GlobalId changing Reference to one owned by a DIFFERENT space → transitional collision, no update", async () => {
    respond([...PRELUDE, AUTHORITY_SINGLE,
        [G, [[{ id: 55, space_uuid: "uuid-55", inventory_code_normalized: "R-OLD" }]]],
        [R, [[{ id: 66, inventory_code_normalized: "R-NEW" }]]]]); // candidate Reference owned by space 66

    await assert.rejects(
        persistSpaceIdentities({ ...CTX, candidates: [cand(GA, "R-NEW", 700)] }),
        (e: any) => {
            assert.ok(e instanceof TransitionalReferenceCollisionError);
            assert.equal(e.code, "transitional_reference_collision");
            assert.equal(e.diagnostics.conflictingSpaceId, 66);
            assert.equal(e.diagnostics.spaceId, 55);
            return true;
        });
    assert.equal(fakeConnection.callsMatching(/UPDATE spaces\s+SET inventory_code/i).length, 0, "no Reference update");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO space_bindings/i).length, 0);
});

/* ==== B''. §6.B: a successful Reference change records the prior value for compensation ==== */
test("B'': changed Reference on a reused space records previous values in outcome.referenceUpdates", async () => {
    respond([...PRELUDE, AUTHORITY_SINGLE,
        [G, [[{ id: 55, space_uuid: "uuid-55", inventory_code: "R-OLD", inventory_code_normalized: "R-OLD", name: "Old" }]]],
        [R, [[]]],
        [/UPDATE spaces\s+SET inventory_code/i, [{ affectedRows: 1 }]],
        [/INSERT INTO space_bindings/i, [{ insertId: 92, affectedRows: 1 }]]]);
    const outcome = await persistSpaceIdentities({ ...CTX, candidates: [cand(GA, "R-NEW", 700)] });
    assert.equal(outcome.referenceUpdates.length, 1);
    assert.equal(outcome.referenceUpdates[0]!.spaceId, 55);
    assert.equal(outcome.referenceUpdates[0]!.appliedInventoryCodeNormalized, "R-NEW");
    assert.equal(outcome.referenceUpdates[0]!.previousInventoryCodeNormalized, "R-OLD");
});

/* ==== B''''. §6-v4: a NON-Error thrown AFTER a Reference update is normalized, and the
              prior Reference stays available to compensation (no TypeError replaces it) ==== */
test("B'''': a non-Error thrown after a Reference update → normalized Error carrying the prior Reference for compensation", async () => {
    respond([...PRELUDE, AUTHORITY_SINGLE,
        [G, [[{ id: 55, space_uuid: "uuid-55", inventory_code: "R-OLD", inventory_code_normalized: "R-OLD", name: "Old" }]]],
        [R, [[]]],
        [/UPDATE spaces\s+SET inventory_code/i, [{ affectedRows: 1 }]]]);
    // The Reference UPDATE succeeds and is journaled; then createBinding throws a NON-Error
    // (a bare string) — the persistSpaceIdentities catch must normalize it before attaching
    // createdSpaceIds/referenceUpdates, never let a strict-mode property assignment on a
    // string primitive manufacture a TypeError that hides the real failure.
    const originalCreateBinding = (spaceDb as any).createBinding;
    (spaceDb as any).createBinding = async () => { throw "kaboom-string"; };
    try {
        const err: any = await persistSpaceIdentities({ ...CTX, candidates: [cand(GA, "R-NEW", 700)] }).then(
            () => null, (e: any) => e);
        assert.ok(err instanceof Error, "the non-Error throwable is normalized to a stable Error");
        assert.match(err.message, /kaboom-string/, "the normalized failure remains understandable");
        assert.equal(err.cause, "kaboom-string", "the original throwable is preserved as cause");
        // The prior Reference is available to compensation…
        const meta = err as any;
        assert.ok(Array.isArray(meta.referenceUpdates) && meta.referenceUpdates.length === 1);
        assert.equal(meta.referenceUpdates[0].spaceId, 55);
        assert.equal(meta.referenceUpdates[0].previousInventoryCodeNormalized, "R-OLD");
        assert.equal(meta.referenceUpdates[0].appliedInventoryCodeNormalized, "R-NEW");
        assert.deepEqual(meta.createdSpaceIds, [], "no orphan space was created on this reuse path");
    } finally {
        (spaceDb as any).createBinding = originalCreateBinding;
    }
});

/* ==== B'''. §6.A: a concurrent uq_spaces_scope_code dup on UPDATE → translated, no binding ==== */
test("B''': Reference UPDATE race (real legacy dup) → TransitionalReferenceCollisionError, no raw ER_DUP_ENTRY, no binding", async () => {
    respond([...PRELUDE, AUTHORITY_SINGLE,
        [G, [[{ id: 55, space_uuid: "uuid-55", inventory_code: "R-OLD", inventory_code_normalized: "R-OLD", name: "Old" }]]],
        [R, [[]]], // pre-check: free
        [/UPDATE spaces\s+SET inventory_code/i, () => {
            const err: any = new Error("dup"); err.code = "ER_DUP_ENTRY"; err.errno = 1062; err.sqlState = "23000";
            err.sqlMessage = "Duplicate entry '10-R-NEW' for key 'spaces.uq_spaces_scope_code'"; throw err;
        }]]);
    await assert.rejects(
        persistSpaceIdentities({ ...CTX, candidates: [cand(GA, "R-NEW", 700)] }),
        (e: any) => {
            assert.ok(e instanceof TransitionalReferenceCollisionError);
            assert.equal(e.diagnostics.concurrent, true);
            assert.doesNotMatch(String(e.message), /ER_DUP_ENTRY|Duplicate entry/i);
            return true;
        });
    assert.equal(fakeConnection.callsMatching(/INSERT INTO space_bindings/i).length, 0, "no binding after collision");
});

/* ==== B''''. an UNRELATED dup on UPDATE is rethrown (not a Reference collision) ==== */
test("B'''': an unrelated duplicate key on the Reference UPDATE is rethrown, not misclassified", async () => {
    respond([...PRELUDE, AUTHORITY_SINGLE,
        [G, [[{ id: 55, space_uuid: "uuid-55", inventory_code: "R-OLD", inventory_code_normalized: "R-OLD", name: "Old" }]]],
        [R, [[]]],
        [/UPDATE spaces\s+SET inventory_code/i, () => {
            const err: any = new Error("dup"); err.code = "ER_DUP_ENTRY"; err.errno = 1062;
            err.sqlMessage = "Duplicate entry 'x' for key 'spaces.uq_spaces_uuid'"; throw err;
        }]]);
    await assert.rejects(
        persistSpaceIdentities({ ...CTX, candidates: [cand(GA, "R-NEW", 700)] }),
        (e: any) => { assert.ok(!(e instanceof TransitionalReferenceCollisionError)); assert.match(String(e.sqlMessage), /uq_spaces_uuid/); return true; });
});

/* ============ C. DIFFERENT GLOBALID, DIFFERENT REFERENCE ============ */
test("C: different GlobalId + different Reference → new persistent space with ifc_global_id", async () => {
    respond([...PRELUDE, AUTHORITY_SINGLE,
        [G, [[]]], [R, [[]]],
        [/INSERT INTO spaces/i, [{ insertId: 77 }]],
        [/INSERT INTO space_bindings/i, [{ insertId: 93, affectedRows: 1 }]]]);

    const outcome = await persistSpaceIdentities({ ...CTX, candidates: [cand(GB, "R-500", 701)] });

    assert.equal(outcome.diagnostics.created_spaces, 1);
    assert.deepEqual(outcome.createdSpaceIds, [77]);
    const insert = fakeConnection.callsMatching(/INSERT INTO spaces/i)[0]!;
    assert.equal(insert.params.ifcGlobalId, GB, "new row receives its canonical GlobalId");
    assert.equal(insert.params.inventoryCodeNormalized, "R-500");
});

/* ============ D. DIFFERENT GLOBALID, SAME REFERENCE ============ */
test("D: different GlobalId + same Reference → transitional collision, nothing written, no reuse", async () => {
    respond([...PRELUDE, AUTHORITY_SINGLE,
        [G, [[]]],                                   // new GlobalId
        [R, [[{ id: 55, ifc_global_id: GB, inventory_code_normalized: "R-101" }]]]]); // Reference belongs to another space

    await assert.rejects(
        persistSpaceIdentities({ ...CTX, candidates: [cand(GC, "R-101", 702)] }),
        (e: any) => {
            assert.ok(e instanceof TransitionalReferenceCollisionError);
            assert.equal(e.diagnostics.conflictingSpaceId, 55);
            return true;
        });
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO space_bindings/i).length, 0);
});

/* ============ E. SAME GLOBALID, DIFFERENT LINKED_MODELS ============ */
test("E: same GlobalId in different linked_models → distinct persistent spaces (scoped lookup)", async () => {
    respond([...PRELUDE, AUTHORITY_SINGLE, [G, [[]]], [R, [[]]],
        [/INSERT INTO spaces/i, [{ insertId: 80 }]], [/INSERT INTO space_bindings/i, [{ insertId: 95, affectedRows: 1 }]]]);
    await persistSpaceIdentities({ linkedModelId: 10, modelId: 20, modelVersionId: 30, candidates: [cand(GA, "R-1", 710)] });
    const first = fakeConnection.callsMatching(/INSERT INTO spaces/i)[0]!;

    fakeConnection.reset(); resetCanonicalSchemaCache();
    respond([...PRELUDE,
        [/spatial_authority_model_id/i, [[{ spatial_authority_model_id: null, model_count: 1, single_model_id: 21 }]]],
        [G, [[]]], [R, [[]]],
        [/INSERT INTO spaces/i, [{ insertId: 81 }]], [/INSERT INTO space_bindings/i, [{ insertId: 96, affectedRows: 1 }]]]);
    await persistSpaceIdentities({ linkedModelId: 11, modelId: 21, modelVersionId: 31, candidates: [cand(GA, "R-1", 711)] });
    const second = fakeConnection.callsMatching(/INSERT INTO spaces/i)[0]!;

    assert.equal(first.params.linkedModelId, 10);
    assert.equal(second.params.linkedModelId, 11);
    assert.equal(first.params.ifcGlobalId, GA);
    assert.equal(second.params.ifcGlobalId, GA);
});

/* ============ F. CASE-DIFFERENT GLOBALIDS ============ */
test("F: GlobalIds differing only by letter case are distinct (byte-exact) → two new spaces", async () => {
    let nextId = 90;
    respond([...PRELUDE, AUTHORITY_SINGLE, [G, [[]]], [R, [[]]],
        [/INSERT INTO spaces/i, () => [{ insertId: nextId++ }]], [/INSERT INTO space_bindings/i, [{ insertId: 1, affectedRows: 1 }]]]);

    const outcome = await persistSpaceIdentities({
        ...CTX, candidates: [cand(GCASE_L, "R-1", 720), cand(GCASE_U, "R-2", 721)],
    });
    assert.equal(outcome.diagnostics.created_spaces, 2, "case-different GlobalIds are not merged");
});

/* ============ G. DUPLICATE EXACT GLOBALID IN ONE VERSION ============ */
test("G: duplicate exact GlobalId in one candidate version → blocking, no writes", async () => {
    respond([...PRELUDE, AUTHORITY_SINGLE]);
    await assert.rejects(
        persistSpaceIdentities({ ...CTX, candidates: [cand(GA, "R-1", 730), cand(GA, "R-2", 731)] }),
        (e: any) => {
            assert.ok(e instanceof DuplicateSpaceGlobalIdError);
            assert.equal(e.code, "duplicate_candidate_globalid");
            assert.match(e.message, new RegExp(GA));
            return true;
        });
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO space_bindings/i).length, 0);
});

/* ============ H. MISSING OR INVALID GLOBALID (full validator, §1) ============ */
test("H: every invalid GlobalId form → InvalidSpaceGlobalIdError, no Reference fallback, no writes", async () => {
    const invalidForms: Array<{ label: string; guid: any }> = [
        { label: "null", guid: null },
        { label: "undefined", guid: undefined },
        { label: "empty", guid: "" },
        { label: "whitespace-only", guid: "   " },
        { label: "padded valid", guid: ` ${GA} ` },
        { label: "21 chars", guid: GA.slice(0, 21) },
        { label: "23 chars", guid: `${GA}X` },
        { label: "invalid punctuation", guid: `${GA.slice(0, 21)}!` },
    ];
    for (const form of invalidForms) {
        fakeConnection.reset(); resetCanonicalSchemaCache();
        respond([...PRELUDE, AUTHORITY_SINGLE]);
        await assert.rejects(
            persistSpaceIdentities({ ...CTX, candidates: [cand(form.guid, "R-1", 740)] }),
            (e: any) => { assert.ok(e instanceof InvalidSpaceGlobalIdError, form.label); assert.equal(e.code, "invalid_globalid"); return true; },
            `expected ${form.label} to be rejected`);
        assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0, `${form.label}: no space insert`);
        assert.equal(fakeConnection.callsMatching(/INSERT INTO space_bindings/i).length, 0, `${form.label}: no binding insert`);
        assert.equal(fakeConnection.callsMatching(/UPDATE spaces/i).length, 0, `${form.label}: no metadata update`);
    }
});

/* ============ I. STAGE 0A SCHEMA ABSENT ============ */
test("I: canonical schema absent → explicit operational failure, no migration, no Reference fallback", async () => {
    respond(schemaRoutes({ column: null })); // canonical column ABSENT
    await assert.rejects(
        persistSpaceIdentities({ ...CTX, candidates: [cand(GA, "R-1", 750)] }),
        (e: any) => {
            assert.ok(e instanceof SpaceCanonicalSchemaError);
            assert.equal(e.code, "canonical_schema_missing");
            return true;
        });
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);
});

/* ============ I'. NO DATABASE SELECTED (§3.2) ============ */
test("I': null selected database → explicit schema failure, never authorized", async () => {
    respond([[/SELECT DATABASE\(\) AS db/i, [[{ db: null }]]]]);
    await assert.rejects(
        persistSpaceIdentities({ ...CTX, candidates: [cand(GA, "R-1", 750)] }),
        (e: any) => { assert.ok(e instanceof SpaceCanonicalSchemaError); assert.equal(e.code, "canonical_schema_missing"); return true; });
});

/* ============ J. NULL CANONICAL GLOBALID ON EXISTING SPACE ============ */
test("J: an existing space with NULL canonical GlobalId → explicit inconsistency failure", async () => {
    respond([...schemaRoutes(), [/ifc_global_id IS NULL/i, [[{ id: 5 }]]], NO_BINDING_MISMATCH]);
    await assert.rejects(
        persistSpaceIdentities({ ...CTX, candidates: [cand(GA, "R-1", 751)] }),
        (e: any) => { assert.ok(e instanceof SpaceCanonicalSchemaError); assert.equal(e.code, "canonical_inconsistency"); return true; });
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);
});

/* ============ K. CANONICAL/BINDING GLOBALID MISMATCH ============ */
test("K: a binding GlobalId disagreeing with its space canonical → explicit inconsistency, no repair", async () => {
    respond([...schemaRoutes(), NO_NULL_CANONICAL,
        [/BINARY sb\.ifc_guid <> BINARY s\.ifc_global_id/i, [[{ binding_id: 7, space_id: 5, binding_guid: "x", canonical: "y" }]]]]);
    await assert.rejects(
        persistSpaceIdentities({ ...CTX, candidates: [cand(GA, "R-1", 752)] }),
        (e: any) => { assert.ok(e instanceof SpaceCanonicalSchemaError); assert.equal(e.code, "canonical_inconsistency"); return true; });
    assert.equal(fakeConnection.callsMatching(/UPDATE space_bindings/i).length, 0, "no silent repair");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);
});

/* ============ L. LEGACY REFERENCE COLLISION (deterministic) ============ */
test("L: legacy Reference collision surfaces as a typed error, not a raw duplicate-key, no reassignment", async () => {
    respond([...PRELUDE, AUTHORITY_SINGLE,
        [G, [[]]], [R, [[{ id: 99, inventory_code_normalized: "R-1" }]]]]);
    await assert.rejects(
        persistSpaceIdentities({ ...CTX, candidates: [cand(GB, "R-1", 753)] }),
        (e: any) => {
            assert.ok(e instanceof TransitionalReferenceCollisionError);
            assert.doesNotMatch(String(e.message), /ER_DUP_ENTRY|duplicate key/i);
            return true;
        });
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);
});

/* ============ M. CONCURRENT IDENTITY CREATION (verified re-resolution, §6) ============ */
test("M: concurrent creation of the same GlobalId → verified reuse via unique index, no partial state", async () => {
    let globalIdLookups = 0;
    respond([...PRELUDE, AUTHORITY_SINGLE,
        // 1st GlobalId lookup: empty (we think it's new); 2nd (after dup-key): the raced row.
        [G, () => (++globalIdLookups === 1 ? [[]] : [[{ id: 55, space_uuid: "u", inventory_code_normalized: "R-1", linked_model_id: 10, ifc_global_id: GA }]])],
        [R, [[]]],
        [/INSERT INTO spaces/i, () => { const err: any = new Error("dup"); err.code = "ER_DUP_ENTRY"; err.errno = 1062; err.sqlState = "23000"; err.sqlMessage = "Duplicate entry 'x' for key 'spaces.uq_spaces_linked_model_ifc_global_id'"; throw err; }],
        [/INSERT INTO space_bindings/i, [{ insertId: 1, affectedRows: 1 }]]]);

    const outcome = await persistSpaceIdentities({ ...CTX, candidates: [cand(GA, "R-1", 754)] });
    assert.equal(outcome.diagnostics.created_spaces, 0);
    assert.equal(outcome.diagnostics.reused_spaces, 1, "resolved to the concurrently-created identity");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO space_bindings/i)[0]!.params.spaceId, 55);
});

test("M': an UNRELATED duplicate-key on insert is never misread as a canonical race → rethrown", async () => {
    respond([...PRELUDE, AUTHORITY_SINGLE, [G, [[]]], [R, [[]]],
        [/INSERT INTO spaces/i, () => { const err: any = new Error("dup"); err.code = "ER_DUP_ENTRY"; err.errno = 1062; err.sqlState = "23000"; err.sqlMessage = "Duplicate entry 'z' for key 'spaces.uq_spaces_uuid'"; throw err; }]]);
    await assert.rejects(
        persistSpaceIdentities({ ...CTX, candidates: [cand(GC, "R-1", 754)] }),
        (e: any) => {
            assert.ok(!(e instanceof TransitionalReferenceCollisionError), "not a Reference collision");
            assert.match(String(e.sqlMessage), /uq_spaces_uuid/);
            return true;
        });
});

/* ============ N. DEPENDENT REFERENCES: spaces.id STABILITY ============ */
test("N: reuse keeps spaces.id stable so dependent asset/reservation/location relations are preserved", async () => {
    respond([...PRELUDE, AUTHORITY_SINGLE,
        [G, [[{ id: 55, space_uuid: "uuid-55", inventory_code_normalized: "R-1" }]]],
        [/INSERT INTO space_bindings/i, [{ insertId: 1, affectedRows: 1 }]]]);
    const outcome = await persistSpaceIdentities({ ...CTX, candidates: [cand(GA, "R-1", 755)] });
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0, "no new spaces.id minted");
    assert.equal(outcome.spaceInfoByGuid[GA]!.spaceId, 55, "dependent relations keep pointing at 55");
});

/* ============ REFERENCE GATE (transitional, unchanged) ============ */
test("missing Reference (authoritative) is still skipped as a diagnostic (transitionally required)", async () => {
    respond([...PRELUDE, AUTHORITY_SINGLE]);
    const outcome = await persistSpaceIdentities({ ...CTX, candidates: [cand(GNOREF, null, 760)] });
    assert.deepEqual(outcome.diagnostics.ignored_missing_inventory_code, [GNOREF]);
    assert.equal(outcome.bindingsCreated, 0);
});

test("duplicate Reference (authoritative) still blocks via DuplicateSpaceReferenceError", async () => {
    respond([...PRELUDE, AUTHORITY_SINGLE]);
    await assert.rejects(
        persistSpaceIdentities({ ...CTX, candidates: [cand(GX, "R-101", 761), cand(GY, " R-101 ", 762)] }),
        (e: any) => { assert.ok(e instanceof DuplicateSpaceReferenceError); return true; });
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);
});

test("duplicate Reference (non-authoritative) → ignore duplicates, persist the rest", async () => {
    respond([...PRELUDE, AUTHORITY_UNDETERMINED, [G, [[]]], [R, [[]]],
        [/INSERT INTO spaces/i, [{ insertId: 88 }]], [/INSERT INTO space_bindings/i, [{ insertId: 99, affectedRows: 1 }]]]);
    const outcome = await persistSpaceIdentities({
        ...CTX, candidates: [cand(GX, "R-200", 763), cand(GY, "R-200", 764), cand(GZ, "R-300", 765)],
    });
    assert.equal(outcome.diagnostics.duplicate_reference.length, 1);
    assert.equal(outcome.bindingsCreated, 1);
    assert.equal(outcome.diagnostics.isAuthoritative, false);
});

/* ============ RECONCILIATION + COMPENSATION (unchanged) ============ */
test("reconciliation: absent codes → 'absent', present → 'active', never DELETE", async () => {
    respond([AUTHORITY_SINGLE, [/UPDATE spaces SET status/i, [{}]]]);
    await reconcileSpaceStatusesAfterActivation({ linkedModelId: 10, modelId: 20, presentNormalizedCodes: ["R-101B", "R-101C"] });
    const updates = fakeConnection.callsMatching(/UPDATE spaces SET status/i);
    assert.equal(updates.length, 2);
    assert.match(updates[0]!.sql, /'absent'/);
    assert.equal(fakeConnection.callsMatching(/DELETE FROM spaces/i).length, 0);
});

test("reconciliation on a non-authoritative model performs no status update", async () => {
    respond([[/spatial_authority_model_id/i, [[{ spatial_authority_model_id: 99, model_count: 3, single_model_id: 20 }]]]]);
    await reconcileSpaceStatusesAfterActivation({ linkedModelId: 10, modelId: 20, presentNormalizedCodes: [] });
    assert.equal(fakeConnection.callsMatching(/UPDATE spaces/i).length, 0);
});

test("deleteSpacesWithoutBindings only removes spaces with no binding (NOT EXISTS guard)", async () => {
    respond([[/DELETE FROM spaces/i, [{}]]]);
    await spaceDb.deleteSpacesWithoutBindings([101, 102]);
    const deletes = fakeConnection.callsMatching(/DELETE FROM spaces/i);
    assert.equal(deletes.length, 2);
    for (const d of deletes) assert.match(d.sql, /NOT EXISTS/i);
});
