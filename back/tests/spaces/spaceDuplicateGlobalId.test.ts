/**
 * Stage 0B (ADR-0051 §1/§2/§3): lossless duplicate-GlobalId detection and full
 * preview visibility.
 *
 *  - Object.keys(inventoryData) CANNOT detect duplicate GlobalIds because the dict
 *    is keyed by GlobalId (duplicates already collapsed). The Python extraction now
 *    emits an ordered, lossless `spaceOccurrences` list; deriveSpaceOccurrences uses
 *    it, groupDuplicateGlobalIds detects duplicates over it, and persistSpaceIdentities
 *    blocks BEFORE any write.
 *  - The preview emits EVERY occurrence (no silent `continue`) with a stable code:
 *    invalid_globalid > duplicate_candidate_globalid > missing_reference > schema >
 *    existing/new/transitional_reference_collision.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";
import { schemaRoutes, SCOPE_CLEAN } from "../helpers/spaceSchemaFixtures.ts";

installFakeMySQL();
const { persistSpaceIdentities, DuplicateSpaceGlobalIdError, InvalidSpaceGlobalIdError,
    LosslessSpaceOccurrencesMissingError, LosslessSpaceOccurrencesInconsistentError,
    validateLosslessOccurrenceContract } = await import("../../services/spaceIdentityService.ts");
const { deriveSpaceOccurrences, groupDuplicateGlobalIds } = await import("../../services/spatialPreflightService.ts");
const { buildSpacePreviewEntries } = await import("../../modelIntake/modelIntakeService.ts");
const identityProvider = await import("../../identity/spaceIdentityProvider.ts");
const { resetCanonicalSchemaCache } = await import("../../utils/spaceDatabase.ts");

beforeEach(() => { fakeConnection.reset(); identityProvider.resetSpaceIdentityResolver(); resetCanonicalSchemaCache(); });

const GA = "3VKKG6_QDBqgUlHMH5Q4EB";
const GB = "2TYxeEXST7MP9bl8QCa9Ti";
const GC = "2TYxeEXST7MP9bl8QCa9Od";
const GA_LOWER = "aaaaaaaaaaaaaaaaaaaa1a";
const GA_UPPER = "aaaaaaaaaaaaaaaaaaaa1A";

/* ---------- deriveSpaceOccurrences: lossless vs collapse ---------- */
test("deriveSpaceOccurrences uses the lossless spaceOccurrences list when present (duplicates retained)", () => {
    const occ = deriveSpaceOccurrences({
        spaceOccurrences: [
            { entityId: 1, guid: GA, name: "A1", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } } },
            { entityId: 2, guid: GA, name: "A2", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-2" } } },
        ],
        inventoryData: { [GA]: { spaceName: "collapsed" } },
    });
    assert.equal(occ.length, 2, "both occurrences of the same GlobalId are retained");
    assert.deepEqual(occ.map((o) => o.entityId), [1, 2]);
});

test("deriveSpaceOccurrences falls back to inventoryData keys (carrying raw psets, cannot reveal duplicates)", () => {
    const occ = deriveSpaceOccurrences({
        inventoryData: { [GA]: { spaceName: "A", spaceLongName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } } } },
    } as any);
    assert.equal(occ.length, 1);
    assert.equal(occ[0]!.guid, GA);
    assert.equal(occ[0]!.psets?.Pset_SpaceCommon?.Reference, "R-1");
});

test("groupDuplicateGlobalIds detects exact duplicates and keeps case-different GlobalIds distinct", () => {
    const dup = groupDuplicateGlobalIds([{ guid: GA }, { guid: GA }, { guid: GB }]);
    assert.equal(dup.size, 1);
    assert.deepEqual([...dup.keys()], [GA]);
    const distinct = groupDuplicateGlobalIds([{ guid: GA_LOWER }, { guid: GA_UPPER }]);
    assert.equal(distinct.size, 0, "case-different GlobalIds are not duplicates");
});

/* ---------- persistSpaceIdentities blocks duplicates BEFORE any write ---------- */
test("persistSpaceIdentities blocks a duplicate GlobalId detected via lossless occurrences (candidates collapsed)", async () => {
    respond([...schemaRoutes(), ...SCOPE_CLEAN,
        [/spatial_authority_model_id/i, [[{ spatial_authority_model_id: null, model_count: 1, single_model_id: 20 }]]]]);
    await assert.rejects(
        persistSpaceIdentities({
            linkedModelId: 10, modelId: 20, modelVersionId: 30,
            // candidates is already GlobalId-collapsed (one entry); occurrences is lossless (two).
            candidates: [{ guid: GA, name: "A", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } }, entityId: 700 }],
            occurrences: [
                { guid: GA, name: "A1", longName: null, entityId: 700 },
                { guid: GA, name: "A2", longName: null, entityId: 701 },
            ],
        }),
        (e: any) => {
            assert.ok(e instanceof DuplicateSpaceGlobalIdError);
            assert.equal(e.diagnostics[0].candidateCount, 2);
            return true;
        });
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO space_bindings/i).length, 0);
});

/* ---------- preview emits EVERY candidate with a stable code ---------- */
const previewDeps = {
    baseUri: "https://x", runUuid: "run-1",
    storeyOf: () => null,
    findByGlobalId: async () => null,
    findByInventoryCode: async () => null,
};

test("preview: duplicate GlobalId marks BOTH occurrences duplicate_candidate_globalid; every candidate is present", async () => {
    const entries = await buildSpacePreviewEntries({
        ...previewDeps,
        precondition: async () => ({ code: "ok", message: null }),
        occurrences: [
            { guid: GA, name: "A1", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } } },
            { guid: GA, name: "A2", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-2" } } },
            { guid: GB, name: "B", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-3" } } },
        ],
    });
    assert.equal(entries.length, 3, "every occurrence is emitted");
    assert.equal(entries[0]!.blockingCode, "duplicate_candidate_globalid");
    assert.equal(entries[1]!.blockingCode, "duplicate_candidate_globalid");
    assert.equal(entries[2]!.blockingCode, "new");
});

test("preview: Name-less and invalid candidates are VISIBLE with precise codes (no silent skip)", async () => {
    const entries = await buildSpacePreviewEntries({
        ...previewDeps,
        precondition: async () => ({ code: "ok", message: null }),
        occurrences: [
            { guid: GA, name: null, longName: null, psets: null },                                         // missing_space_name
            { guid: GB, name: "   ", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-x" } } },  // whitespace-only Name → missing (Reference ignored)
            { guid: "not-valid!!", name: "bad", longName: null, psets: null },                             // invalid_globalid (precedence)
            { guid: GC, name: "T-9", longName: "Long", psets: { Pset_SpaceCommon: { Reference: "R-9" } } }, // new (Name governs; Reference ignored)
        ],
    });
    assert.equal(entries.length, 4, "no candidate is dropped");
    assert.equal(entries[0]!.blockingCode, "missing_space_name");
    assert.equal(entries[1]!.blockingCode, "missing_space_name");
    assert.equal(entries[2]!.blockingCode, "invalid_globalid");
    assert.equal(entries[3]!.blockingCode, "new");
    // Visible identity metadata retained even when blocked.
    assert.equal(entries[0]!.ifcGlobalId, GA);
    assert.equal(entries[3]!.longName, "Long");
});

test("preview precedence (§3): a candidate-local error is reported even when the Stage 0A schema is ABSENT", async () => {
    let lookups = 0;
    const entries = await buildSpacePreviewEntries({
        ...previewDeps,
        findByGlobalId: async () => { lookups++; return null; },
        findByInventoryCode: async () => { lookups++; return null; },
        precondition: async () => ({ code: "canonical_schema_missing", message: "schema not exact" }),
        occurrences: [
            { guid: "not-valid!!", name: "bad", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } } }, // invalid_globalid
            { guid: GA, name: "d1", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } } },              // duplicate…
            { guid: GA, name: "d2", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } } },              // …duplicate
            { guid: GB, name: null, longName: null, psets: null },                                                    // missing_space_name
            { guid: GC, name: "T-9", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-9" } } },             // → schema (only after clearing local)
        ],
    });
    // §3 precedence: invalid_globalid > duplicate_candidate_globalid > missing_space_name
    // > canonical_schema_missing. A schema failure never HIDES a candidate-local error.
    assert.equal(entries[0]!.blockingCode, "invalid_globalid");
    assert.equal(entries[1]!.blockingCode, "duplicate_candidate_globalid");
    assert.equal(entries[2]!.blockingCode, "duplicate_candidate_globalid");
    assert.equal(entries[3]!.blockingCode, "missing_space_name");
    assert.equal(entries[4]!.blockingCode, "canonical_schema_missing");
    assert.equal(entries[4]!.persistentSpaceStatus, "schema_error");
    assert.equal(lookups, 0, "the schema failure still gates all DB identity lookups");
});

test("preview: a failing Stage 0A precondition dominates every candidate with its controlled code", async () => {
    let lookups = 0;
    const entries = await buildSpacePreviewEntries({
        ...previewDeps,
        findByGlobalId: async () => { lookups++; return null; },
        precondition: async () => ({ code: "canonical_schema_missing", message: "schema not exact" }),
        occurrences: [
            { guid: GA, name: "A", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } } },
            { guid: GB, name: "B", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-2" } } },
        ],
    });
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e) => e.blockingCode === "canonical_schema_missing" && e.persistentSpaceStatus === "schema_error"));
    assert.equal(lookups, 0, "no identity lookup runs when the schema precondition fails");
});

/* ============ §1-v3: the SHARED mandatory lossless contract validator ============ */
const OA = { entityId: 1, guid: GA, name: "A", longName: null };
const OB = { entityId: 2, guid: GB, name: "B", longName: null };
const OC = { entityId: 3, guid: GC, name: "C", longName: null };

test("contract: missing/undefined/non-array occurrences → LosslessSpaceOccurrencesMissingError", () => {
    for (const bad of [undefined, null, "x", 5, {}]) {
        assert.throws(
            () => validateLosslessOccurrenceContract({ occurrences: bad as any, expectedGuids: [GA], modelVersionId: 1, linkedModelId: 10 }),
            (e: any) => e instanceof LosslessSpaceOccurrencesMissingError && e.code === "lossless_space_occurrences_missing");
    }
});

test("contract: empty occurrences while the inventory has spaces → inconsistent", () => {
    assert.throws(
        () => validateLosslessOccurrenceContract({ occurrences: [], expectedGuids: [GA, GB], modelVersionId: 1, linkedModelId: 10 }),
        (e: any) => e instanceof LosslessSpaceOccurrencesInconsistentError && e.code === "lossless_space_occurrences_inconsistent"
            && e.diagnostics.reason === "empty_occurrences");
});

test("contract: a candidate GlobalId omitted from occurrences → inconsistent (missing set)", () => {
    assert.throws(
        () => validateLosslessOccurrenceContract({ occurrences: [OA], expectedGuids: [GA, GB], modelVersionId: 1, linkedModelId: 10 }),
        (e: any) => e instanceof LosslessSpaceOccurrencesInconsistentError && e.diagnostics.reason === "set_mismatch"
            && e.diagnostics.missing.includes(GB) && e.diagnostics.extra.length === 0);
});

test("contract: an occurrence GlobalId absent from the inventory → inconsistent (extra set)", () => {
    assert.throws(
        () => validateLosslessOccurrenceContract({ occurrences: [OA, OB], expectedGuids: [GA], modelVersionId: 1, linkedModelId: 10 }),
        (e: any) => e instanceof LosslessSpaceOccurrencesInconsistentError && e.diagnostics.reason === "set_mismatch"
            && e.diagnostics.extra.includes(GB));
});

test("contract: missing occurrence entity id → inconsistent", () => {
    assert.throws(
        () => validateLosslessOccurrenceContract({ occurrences: [{ guid: GA, name: "A", longName: null, entityId: null } as any], expectedGuids: [GA], modelVersionId: 1, linkedModelId: 10 }),
        (e: any) => e instanceof LosslessSpaceOccurrencesInconsistentError && e.diagnostics.reason === "missing_entity_id");
});

test("contract: duplicated occurrence entity id → inconsistent", () => {
    assert.throws(
        () => validateLosslessOccurrenceContract({ occurrences: [{ ...OA }, { guid: GB, name: "B", longName: null, entityId: 1 }], expectedGuids: [GA, GB], modelVersionId: 1, linkedModelId: 10 }),
        (e: any) => e instanceof LosslessSpaceOccurrencesInconsistentError && e.diagnostics.reason === "duplicate_entity_id");
});

test("contract: an invalid occurrence GlobalId → InvalidSpaceGlobalIdError (before set/entity checks)", () => {
    assert.throws(
        () => validateLosslessOccurrenceContract({ occurrences: [{ guid: "bad!!", name: "x", longName: null, entityId: 1 } as any], expectedGuids: ["bad!!"], modelVersionId: 1, linkedModelId: 10 }),
        (e: any) => e instanceof InvalidSpaceGlobalIdError);
});

test("contract: a real duplicate occurrence → DuplicateSpaceGlobalIdError (before set check)", () => {
    assert.throws(
        () => validateLosslessOccurrenceContract({ occurrences: [{ ...OA }, { guid: GA, name: "A2", longName: null, entityId: 2 }], expectedGuids: [GA], modelVersionId: 1, linkedModelId: 10 }),
        (e: any) => e instanceof DuplicateSpaceGlobalIdError);
});

test("contract: exact valid correspondence → returns the occurrences", () => {
    const out = validateLosslessOccurrenceContract({ occurrences: [OA, OB, OC], expectedGuids: [GA, GB, GC], modelVersionId: 1, linkedModelId: 10 });
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((o) => o.entityId), [1, 2, 3]);
});

/* ============ §5-v4: runtime SHAPE validation of every occurrence ============ */
test("contract: malformed occurrence elements → lossless_space_occurrences_inconsistent (never a TypeError)", () => {
    const cases: Array<{ occ: any; reason: string }> = [
        { occ: [null], reason: "malformed_occurrence" },
        { occ: [42], reason: "malformed_occurrence" },
        { occ: ["x"], reason: "malformed_occurrence" },
        { occ: [{}], reason: "missing_entity_id" },                                              // object, no entity id
        { occ: [{ guid: GA, entityId: "1" }], reason: "invalid_entity_id" },                     // numeric string
        { occ: [{ guid: GA, entityId: Number.NaN }], reason: "invalid_entity_id" },
        { occ: [{ guid: GA, entityId: Infinity }], reason: "invalid_entity_id" },
        { occ: [{ guid: GA, entityId: 1.5 }], reason: "invalid_entity_id" },                     // fractional
        { occ: [{ guid: GA, entityId: 0 }], reason: "invalid_entity_id" },                       // zero
        { occ: [{ guid: GA, entityId: -3 }], reason: "invalid_entity_id" },                      // negative
        { occ: [{ guid: GA, entityId: null }], reason: "missing_entity_id" },
        { occ: [{ guid: GA, entityId: 1, name: 7 }], reason: "malformed_occurrence" },           // non-string name
        { occ: [{ guid: GA, entityId: 1, storeyName: {} }], reason: "malformed_occurrence" },    // non-string storey
        { occ: [{ guid: GA, entityId: 1, psets: 5 }], reason: "malformed_occurrence" },          // non-object psets
    ];
    for (const { occ, reason } of cases) {
        assert.throws(
            () => validateLosslessOccurrenceContract({ occurrences: occ, expectedGuids: [GA], modelVersionId: 1, linkedModelId: 10 }),
            (e: any) => {
                assert.ok(e instanceof LosslessSpaceOccurrencesInconsistentError, `expected inconsistent for ${JSON.stringify(occ)}, got ${e?.name}`);
                assert.equal(e.code, "lossless_space_occurrences_inconsistent");
                assert.equal(e.diagnostics.reason, reason, `reason for ${JSON.stringify(occ)}`);
                return true;
            });
    }
});

test("contract: a non-string GlobalId (shape ok, entityId valid) → InvalidSpaceGlobalIdError, not a Reference fallback", () => {
    // guid is passed to the shared GlobalId validator whatever its runtime type (§5-v4);
    // a numeric GlobalId is a blocking invalid GlobalId, exactly like a malformed string.
    assert.throws(
        () => validateLosslessOccurrenceContract({ occurrences: [{ guid: 5 as any, entityId: 1 }], expectedGuids: [], modelVersionId: 1, linkedModelId: 10 }),
        (e: any) => e instanceof InvalidSpaceGlobalIdError);
});

test("contract: a duplicated valid entity id → duplicate_entity_id; a fully valid occurrence set is returned", () => {
    assert.throws(
        () => validateLosslessOccurrenceContract({
            occurrences: [{ guid: GA, entityId: 5, name: "A", longName: null, storeyName: "L1" },
                { guid: GB, entityId: 5, name: "B", longName: null, storeyName: null }],
            expectedGuids: [GA, GB], modelVersionId: 1, linkedModelId: 10 }),
        (e: any) => e instanceof LosslessSpaceOccurrencesInconsistentError && e.diagnostics.reason === "duplicate_entity_id");
    const out = validateLosslessOccurrenceContract({
        occurrences: [{ guid: GA, entityId: 5, name: "A", longName: null, storeyName: "L1", psets: { Pset_SpaceCommon: { Reference: "R-1" } } }],
        expectedGuids: [GA], modelVersionId: 1, linkedModelId: 10 });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.entityId, 5);
});

test("persistSpaceIdentities returns the contract error for malformed occurrences even when the DB is unavailable (§5-v4)", async () => {
    // No schema/scope routes are registered: any DB access would reject. The pure contract
    // validation runs FIRST, so a malformed shape returns the contract error, not a DB error.
    await assert.rejects(
        persistSpaceIdentities({ linkedModelId: 10, modelId: 20, modelVersionId: 30,
            candidates: [{ guid: GA, name: "A", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } }, entityId: 700 }],
            occurrences: [{ guid: GA, entityId: "700" }] } as any),
        (e: any) => e instanceof LosslessSpaceOccurrencesInconsistentError && e.diagnostics.reason === "invalid_entity_id");
    assert.equal(fakeConnection.callsMatching(/SELECT DATABASE\(\)/i).length, 0, "no schema/database access before the contract check");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);
});

test("persistSpaceIdentities independently rejects a non-array occurrences (never trusts candidates)", async () => {
    respond([...schemaRoutes(), ...SCOPE_CLEAN,
        [/spatial_authority_model_id/i, [[{ spatial_authority_model_id: null, model_count: 1, single_model_id: 20 }]]]]);
    await assert.rejects(
        persistSpaceIdentities({ linkedModelId: 10, modelId: 20, modelVersionId: 30,
            candidates: [{ guid: GA, name: "A", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } }, entityId: 700 }],
            occurrences: undefined } as any),
        (e: any) => e instanceof LosslessSpaceOccurrencesMissingError);
    assert.equal(fakeConnection.callsMatching(/INSERT INTO spaces/i).length, 0);
});

/* ============ §2-v3: preview precondition is LAZY (no DB when not needed) ============ */
test("preview: precondition is NOT called when no candidate needs DB resolution (zero schema queries)", async () => {
    let preCalls = 0, lookups = 0;
    const entries = await buildSpacePreviewEntries({
        ...previewDeps,
        findByGlobalId: async () => { lookups++; return null; },
        precondition: async () => { preCalls++; return { code: "ok", message: null }; },
        occurrences: [
            { guid: "bad!!", name: "x", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } } }, // invalid
            { guid: GA, name: "d", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } } },       // duplicate…
            { guid: GA, name: "d2", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } } },      // …duplicate
            { guid: GB, name: null, longName: null, psets: null },                                            // missing_space_name
        ],
    });
    assert.equal(preCalls, 0, "no candidate needs resolution → precondition never invoked");
    assert.equal(lookups, 0);
    assert.deepEqual(entries.map((e) => e.blockingCode),
        ["invalid_globalid", "duplicate_candidate_globalid", "duplicate_candidate_globalid", "missing_space_name"]);
});

test("preview: precondition raising (checkConnection failure) still yields candidate-local codes; valid one gets schema code", async () => {
    let preCalls = 0;
    // The lazy precondition SIMULATES a connection failure surfaced as the controlled code
    // (checkCanonicalPreconditionForScope catches raw errors and returns this).
    const entries = await buildSpacePreviewEntries({
        ...previewDeps,
        findByGlobalId: async () => { throw new Error("MySQL down"); },
        precondition: async () => { preCalls++; return { code: "canonical_schema_missing", message: "The canonical IfcSpace identity schema could not be verified." }; },
        occurrences: [
            { guid: "bad!!", name: "x", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } } }, // invalid (no DB)
            { guid: GA, name: "d", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } } },       // duplicate (no DB)
            { guid: GA, name: "d2", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } } },      // duplicate (no DB)
            { guid: GC, name: null, longName: null, psets: null },                                            // missing_space_name (no DB)
            { guid: GB, name: "T-2", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-2" } } },     // needs DB → schema code
        ],
    });
    assert.equal(preCalls, 1, "precondition fetched once for the one candidate that needs resolution");
    assert.deepEqual(entries.map((e) => e.blockingCode),
        ["invalid_globalid", "duplicate_candidate_globalid", "duplicate_candidate_globalid", "missing_space_name", "canonical_schema_missing"]);
    assert.doesNotMatch(entries[4]!.blockingError ?? "", /MySQL down|SELECT|at \w+\./i);
});

/* ============ §3-v3: each occurrence has a distinct preview identity ============ */
test("preview: two duplicate occurrences expose distinct entity ids, distinct URIs, own storeys/Names", async () => {
    const entries = await buildSpacePreviewEntries({
        ...previewDeps,
        precondition: async () => ({ code: "ok", message: null }),
        occurrences: [
            { guid: GA, name: "Alpha", longName: null, entityId: 8, storeyName: "L1", psets: { Pset_SpaceCommon: { Reference: "R-1" } } },
            { guid: GA, name: "Beta", longName: null, entityId: 9, storeyName: "L2", psets: { Pset_SpaceCommon: { Reference: "R-2" } } },
        ],
    });
    assert.equal(entries.length, 2);
    // Same duplicate GlobalId diagnostic…
    assert.ok(entries.every((e) => e.blockingCode === "duplicate_candidate_globalid" && e.ifcGlobalId === GA));
    // …but distinct entity ids, storeys, Names and manifestation/candidate URIs.
    assert.deepEqual(entries.map((e) => e.ifcEntityId), [8, 9]);
    assert.deepEqual(entries.map((e) => e.storey), ["L1", "L2"]);
    assert.deepEqual(entries.map((e) => e.name), ["Alpha", "Beta"]);
    assert.notEqual(entries[0]!.manifestationUri, entries[1]!.manifestationUri);
    assert.notEqual(entries[0]!.persistentUri, entries[1]!.persistentUri);
    assert.match(entries[0]!.manifestationUri, /occ-8/);
    assert.match(entries[1]!.manifestationUri, /occ-9/);
});
