/**
 * RZ-2B1 — pure structural validator + pure identity classifier tests.
 * Zero database access. Zero ReservationZone writes (there is no write path
 * in this slice). Traceability numbers refer to the frozen RZ-2B1 test matrix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    validateReservationZoneOccurrences,
    ReservationZoneOccurrenceValidationError,
} from "../../identity/reservationZoneIdentityValidator.ts";
import { classifyReservationZoneOccurrences } from "../../identity/reservationZoneIdentityClassifier.ts";
import {
    assertRegistryOwnersHaveLineageScopedZoneStatus,
    ReservationZoneIdentitySnapshotIntegrityError,
} from "../../identity/reservationZoneIdentitySnapshotIntegrity.ts";
import type {
    ReservationZoneIdentitySnapshot,
    ValidatedReservationZoneOccurrence,
    ReservationZoneClassificationResult,
} from "../../identity/reservationZoneIdentityTypes.ts";

const G1 = "0AAAAAAAAAAAAAAAAAAAA1";
const G2 = "0AAAAAAAAAAAAAAAAAAAA2";
const G3 = "0AAAAAAAAAAAAAAAAAAAA3";
const G4 = "0AAAAAAAAAAAAAAAAAAAA4";

function occ(entityId: number, globalId: string, name = "Zone", refs: string[] = []) {
    return { entityId, globalId, name, referencedSpaceGlobalIds: refs, ifcClass: "IfcSpatialZone", predefinedType: "RESERVATION" };
}

/** Validate a single occurrence and return it (non-null), for concise test setup. */
function validateOne(rawOcc: unknown): ValidatedReservationZoneOccurrence {
    const v = validateReservationZoneOccurrences([rawOcc])[0];
    if (!v) throw new Error("expected exactly one validated occurrence");
    return v;
}

function snapshot(input: {
    linkedModelId?: number;
    registry?: [string, number][];
    zones?: [number, "active" | "absent" | "retired", string?][];
}): ReservationZoneIdentitySnapshot {
    const zoneStatusById = new Map<number, "active" | "absent" | "retired">();
    const zoneCurrentNameById = new Map<number, string>();
    for (const [id, status, name] of input.zones ?? []) {
        zoneStatusById.set(id, status);
        if (name) zoneCurrentNameById.set(id, name);
    }
    return {
        linkedModelId: input.linkedModelId ?? 1,
        registryByGlobalId: new Map(input.registry ?? []),
        zoneStatusById,
        zoneCurrentNameById,
    };
}

function outcomesByEntity(results: ReservationZoneClassificationResult[]) {
    const map: Record<number, string> = {};
    for (const r of results) if (r.entityId !== null) map[r.entityId] = r.outcome;
    return map;
}

// ==================== STRUCTURAL VALIDATION ====================

test("1. valid occurrence accepted", () => {
    const v = validateOne(occ(1, G1, "Zone A", [G2]));
    assert.equal(v.entityId, 1);
    assert.equal(v.globalId, G1);
    assert.equal(v.name, "Zone A");
    assert.deepEqual(v.referencedSpaceGlobalIds, [G2]);
});

test("2. absent top-level occurrence field rejected (invalid_payload_shape)", () => {
    assert.throws(() => validateReservationZoneOccurrences(undefined), (e: any) => e.reason === "invalid_payload_shape");
    assert.throws(() => validateReservationZoneOccurrences(null), (e: any) => e.reason === "invalid_payload_shape");
});

test("3. non-array payload rejected (invalid_payload_shape)", () => {
    assert.throws(() => validateReservationZoneOccurrences({ not: "an array" }), (e: any) => e.reason === "invalid_payload_shape");
    assert.throws(() => validateReservationZoneOccurrences("string"), (e: any) => e.reason === "invalid_payload_shape");
});

test("4. non-object occurrence rejected (invalid_payload_shape)", () => {
    assert.throws(() => validateReservationZoneOccurrences([null]), (e: any) => e.reason === "invalid_payload_shape");
    assert.throws(() => validateReservationZoneOccurrences(["a string"]), (e: any) => e.reason === "invalid_payload_shape");
    assert.throws(() => validateReservationZoneOccurrences([[1, 2, 3]]), (e: any) => e.reason === "invalid_payload_shape");
});

test("5. invalid entityId rejected", () => {
    assert.throws(() => validateReservationZoneOccurrences([{ ...occ(1, G1), entityId: undefined }]), (e: any) => e.reason === "invalid_entity_id");
    assert.throws(() => validateReservationZoneOccurrences([{ ...occ(1, G1), entityId: 0 }]), (e: any) => e.reason === "invalid_entity_id");
    assert.throws(() => validateReservationZoneOccurrences([{ ...occ(1, G1), entityId: -5 }]), (e: any) => e.reason === "invalid_entity_id");
    assert.throws(() => validateReservationZoneOccurrences([{ ...occ(1, G1), entityId: 1.5 }]), (e: any) => e.reason === "invalid_entity_id");
    assert.throws(() => validateReservationZoneOccurrences([{ ...occ(1, G1), entityId: "1" }]), (e: any) => e.reason === "invalid_entity_id");
});

test("6. duplicate entityId rejected", () => {
    assert.throws(
        () => validateReservationZoneOccurrences([occ(1, G1), occ(1, G2)]),
        (e: any) => e.reason === "duplicate_entity_id" && e.diagnostics.entityId === 1,
    );
});

test("7. missing GlobalId rejected", () => {
    assert.throws(() => validateReservationZoneOccurrences([{ ...occ(1, G1), globalId: undefined }]), (e: any) => e.reason === "invalid_global_id");
    assert.throws(() => validateReservationZoneOccurrences([{ ...occ(1, G1), globalId: null }]), (e: any) => e.reason === "invalid_global_id");
});

test("8. blank GlobalId rejected", () => {
    assert.throws(() => validateReservationZoneOccurrences([{ ...occ(1, G1), globalId: "" }]), (e: any) => e.reason === "invalid_global_id");
    assert.throws(() => validateReservationZoneOccurrences([{ ...occ(1, G1), globalId: "   " }]), (e: any) => e.reason === "invalid_global_id");
});

test("9. malformed compressed GlobalId rejected (wrong length / alphabet / case-sensitive, no trim)", () => {
    assert.throws(() => validateReservationZoneOccurrences([{ ...occ(1, G1), globalId: "tooShort" }]), (e: any) => e.reason === "invalid_global_id");
    assert.throws(() => validateReservationZoneOccurrences([{ ...occ(1, G1), globalId: "not-a-valid-guid!!!!!" }]), (e: any) => e.reason === "invalid_global_id");
    assert.throws(() => validateReservationZoneOccurrences([{ ...occ(1, G1), globalId: ` ${G1}` }]), (e: any) => e.reason === "invalid_global_id");
});

test("10. duplicate exact GlobalId rejected (never case-folded)", () => {
    assert.throws(
        () => validateReservationZoneOccurrences([occ(1, G1), occ(2, G1)]),
        (e: any) => e.reason === "duplicate_global_id" && e.diagnostics.globalId === G1,
    );
    // case-varied GlobalId is NOT treated as a duplicate — exact/case-sensitive semantics.
    const lower = G1.slice(0, -1) + G1.slice(-1).toLowerCase();
    if (lower !== G1) {
        const result = validateReservationZoneOccurrences([occ(1, G1), occ(2, lower)]);
        assert.equal(result.length, 2);
    }
});

test("11. missing Name rejected", () => {
    assert.throws(() => validateReservationZoneOccurrences([{ ...occ(1, G1), name: undefined }]), (e: any) => e.reason === "invalid_name");
    assert.throws(() => validateReservationZoneOccurrences([{ ...occ(1, G1), name: null }]), (e: any) => e.reason === "invalid_name");
});

test("12. blank Name rejected", () => {
    assert.throws(() => validateReservationZoneOccurrences([{ ...occ(1, G1), name: "" }]), (e: any) => e.reason === "invalid_name");
    assert.throws(() => validateReservationZoneOccurrences([{ ...occ(1, G1), name: "   " }]), (e: any) => e.reason === "invalid_name");
});

test("13. invalid referencedSpaceGlobalIds type rejected (non-array)", () => {
    assert.throws(
        () => validateReservationZoneOccurrences([{ ...occ(1, G1), referencedSpaceGlobalIds: "not-array" }]),
        (e: any) => e.reason === "invalid_referenced_space_global_ids",
    );
    assert.throws(
        () => validateReservationZoneOccurrences([{ ...occ(1, G1), referencedSpaceGlobalIds: undefined }]),
        (e: any) => e.reason === "invalid_referenced_space_global_ids",
    );
});

test("14. invalid referencedSpaceGlobalIds member type rejected", () => {
    assert.throws(
        () => validateReservationZoneOccurrences([{ ...occ(1, G1), referencedSpaceGlobalIds: [123] }]),
        (e: any) => e.reason === "invalid_referenced_space_global_ids",
    );
    assert.throws(
        () => validateReservationZoneOccurrences([{ ...occ(1, G1), referencedSpaceGlobalIds: [""] }]),
        (e: any) => e.reason === "invalid_referenced_space_global_ids",
    );
});

// ==================== PURE CLASSIFICATION ====================

test("15. known active owner -> REUSE_EXISTING", () => {
    const v = validateOne(occ(1, G1));
    const snap = snapshot({ registry: [[G1, 10]], zones: [[10, "active"]] });
    const { results } = classifyReservationZoneOccurrences([v], snap);
    assert.equal(results[0]!.outcome, "REUSE_EXISTING");
    assert.equal((results[0] as any).reservationZoneId, 10);
    assert.equal((results[0] as any).ownerStatus, "active");
});

test("16. known absent owner -> REUSE_EXISTING", () => {
    const v = validateOne(occ(1, G1));
    const snap = snapshot({ registry: [[G1, 10]], zones: [[10, "absent"]] });
    const { results } = classifyReservationZoneOccurrences([v], snap);
    assert.equal(results[0]!.outcome, "REUSE_EXISTING");
    assert.equal((results[0] as any).ownerStatus, "absent");
});

test("17. known retired owner -> RETIRED_IDENTITY_CONFLICT", () => {
    const v = validateOne(occ(1, G1));
    const snap = snapshot({ registry: [[G1, 10]], zones: [[10, "retired", "Zone A"]] });
    const { results } = classifyReservationZoneOccurrences([v], snap);
    assert.equal(results[0]!.outcome, "RETIRED_IDENTITY_CONFLICT");
    assert.equal((results[0] as any).reservationZoneId, 10);
    assert.equal((results[0] as any).ownerStatus, "retired");
    assert.equal((results[0] as any).currentName, "Zone A");
});

test("18. retired zone excluded from predecessor pool -> unrelated unknown GID mints (never resurrects)", () => {
    const v = validateOne(occ(2, G2)); // unrelated unknown GID
    const snap = snapshot({ registry: [], zones: [[10, "retired"]] }); // only historical zone is retired
    const { results } = classifyReservationZoneOccurrences([v], snap);
    assert.equal(results[0]!.outcome, "MINT_NEW");
});

test("19. unknown + no unmatched predecessor -> MINT_NEW", () => {
    const v = validateOne(occ(3, G3));
    const snap = snapshot({ registry: [], zones: [] });
    const { results } = classifyReservationZoneOccurrences([v], snap);
    assert.equal(results[0]!.outcome, "MINT_NEW");
});

test("20. unknown + one unmatched predecessor -> IDENTITY_AMBIGUOUS", () => {
    const v = validateOne(occ(3, G3));
    const snap = snapshot({ registry: [], zones: [[10, "active"]] });
    const { results } = classifyReservationZoneOccurrences([v], snap);
    assert.equal(results[0]!.outcome, "IDENTITY_AMBIGUOUS");
    assert.deepEqual((results[0] as any).candidatePredecessorZoneIds, [10]);
});

test("21. unknown + several unmatched predecessors -> IDENTITY_AMBIGUOUS with all candidates", () => {
    const v = validateOne(occ(3, G3));
    const snap = snapshot({ registry: [], zones: [[10, "active"], [20, "absent"]] });
    const { results } = classifyReservationZoneOccurrences([v], snap);
    assert.equal(results[0]!.outcome, "IDENTITY_AMBIGUOUS");
    assert.deepEqual((results[0] as any).candidatePredecessorZoneIds, [10, 20]);
});

test("22. known historical alternate GID -> same zone reuse (both G1-only and G2-only)", () => {
    const snap = snapshot({ registry: [[G1, 10], [G2, 10]], zones: [[10, "active"]] });
    const vg1 = validateOne(occ(1, G1));
    const r1 = classifyReservationZoneOccurrences([vg1], snap).results[0]!;
    assert.equal(r1.outcome, "REUSE_EXISTING");
    assert.equal((r1 as any).reservationZoneId, 10);

    const vg2 = validateOne(occ(1, G2));
    const r2 = classifyReservationZoneOccurrences([vg2], snap).results[0]!;
    assert.equal(r2.outcome, "REUSE_EXISTING");
    assert.equal((r2 as any).reservationZoneId, 10);
});

test("23. G1 and G2 both resolve same zone in same input -> INVALID_OCCURRENCE multiple_manifestations_same_identity", () => {
    const snap = snapshot({ registry: [[G1, 10], [G2, 10]], zones: [[10, "active"]] });
    const validated = validateReservationZoneOccurrences([occ(1, G1), occ(2, G2)]);
    const { results } = classifyReservationZoneOccurrences(validated, snap);
    assert.equal(results.length, 2);
    for (const r of results) {
        assert.equal(r.outcome, "INVALID_OCCURRENCE");
        assert.equal((r as any).reason, "multiple_manifestations_same_identity");
        assert.equal((r as any).reservationZoneId, 10);
    }
    assert.deepEqual((results[0] as any).conflictingEntityIds, [2]);
    assert.deepEqual((results[1] as any).conflictingEntityIds, [1]);
});

test("24. matched-zone set counts a multi-GID owner once (does not inflate MATCHED_EXISTING_ZONES)", () => {
    // G1 and G2 both own zone 10 in history but only G1 is incoming; an unrelated
    // unknown G3 must see zone 10 as matched (excluded from predecessor pool) exactly once.
    const snap = snapshot({ registry: [[G1, 10]], zones: [[10, "active"], [20, "active"]] });
    const validated = validateReservationZoneOccurrences([occ(1, G1), occ(3, G3)]);
    const { byEntityId } = classifyReservationZoneOccurrences(validated, snap);
    assert.equal(byEntityId.get(1)!.outcome, "REUSE_EXISTING");
    const ambiguous = byEntityId.get(3)!;
    assert.equal(ambiguous.outcome, "IDENTITY_AMBIGUOUS");
    // Only zone 20 remains unmatched — zone 10 is excluded exactly once.
    assert.deepEqual((ambiguous as any).candidatePredecessorZoneIds, [20]);
});

test("25. multiple unknowns use the SAME frozen unmatched pool (no greedy pairing)", () => {
    const snap = snapshot({ registry: [], zones: [[10, "active"], [20, "absent"]] });
    const validated = validateReservationZoneOccurrences([occ(3, G3), occ(4, G4)]);
    const { byEntityId } = classifyReservationZoneOccurrences(validated, snap);
    const a = byEntityId.get(3)!;
    const b = byEntityId.get(4)!;
    assert.equal(a.outcome, "IDENTITY_AMBIGUOUS");
    assert.equal(b.outcome, "IDENTITY_AMBIGUOUS");
    assert.deepEqual((a as any).candidatePredecessorZoneIds, [10, 20]);
    assert.deepEqual((b as any).candidatePredecessorZoneIds, [10, 20]);
});

test("26. duplicate Names across occurrences do not alter classification", () => {
    const snap = snapshot({ registry: [[G1, 10]], zones: [[10, "active"]] });
    const validated = validateReservationZoneOccurrences([occ(1, G1, "Same Name"), occ(2, G2, "Same Name")]);
    const { byEntityId } = classifyReservationZoneOccurrences(validated, snap);
    assert.equal(byEntityId.get(1)!.outcome, "REUSE_EXISTING");
    assert.equal(byEntityId.get(2)!.outcome, "MINT_NEW");
});

test("27. changed Name does not alter classification (unknown/unmatched-predecessor case)", () => {
    const snap = snapshot({ registry: [], zones: [[10, "active"]] });
    const vSame = validateOne(occ(3, G3, "Zone A")); // same name as predecessor
    const vDiff = validateOne(occ(3, G3, "Totally Different"));
    const rSame = classifyReservationZoneOccurrences([vSame], snap).results[0]!;
    const rDiff = classifyReservationZoneOccurrences([vDiff], snap).results[0]!;
    assert.equal(rSame.outcome, "IDENTITY_AMBIGUOUS");
    assert.equal(rDiff.outcome, "IDENTITY_AMBIGUOUS");
    assert.deepEqual((rSame as any).candidatePredecessorZoneIds, (rDiff as any).candidatePredecessorZoneIds);
});

test("28. equal referencedSpaceGlobalIds do not alter classification (unknown/no-predecessor case)", () => {
    const snap = snapshot({ registry: [], zones: [] });
    const v1 = validateOne(occ(3, G3, "Zone", [G4]));
    const v2 = validateOne(occ(3, G3, "Zone", [G4]));
    const r1 = classifyReservationZoneOccurrences([v1], snap).results[0]!;
    const r2 = classifyReservationZoneOccurrences([v2], snap).results[0]!;
    assert.equal(r1.outcome, "MINT_NEW");
    assert.equal(r2.outcome, "MINT_NEW");
});

test("29. changed referencedSpaceGlobalIds do not alter classification (unknown/no-predecessor case)", () => {
    const snap = snapshot({ registry: [], zones: [] });
    const v1 = validateOne(occ(3, G3, "Zone", [G4]));
    const v2 = validateOne(occ(3, G3, "Zone", [G1, G2]));
    const r1 = classifyReservationZoneOccurrences([v1], snap).results[0]!;
    const r2 = classifyReservationZoneOccurrences([v2], snap).results[0]!;
    assert.equal(r1.outcome, "MINT_NEW");
    assert.equal(r2.outcome, "MINT_NEW");
});

test("30. order permutations produce equivalent results (order-independence, whole-set)", () => {
    const snap = snapshot({ registry: [[G1, 10]], zones: [[10, "active"], [20, "absent"]] });
    const orderA = validateReservationZoneOccurrences([occ(1, G1), occ(3, G3), occ(4, G4)]);
    const orderB = validateReservationZoneOccurrences([occ(4, G4), occ(1, G1), occ(3, G3)]);

    const resA = classifyReservationZoneOccurrences(orderA, snap).results.map((r) => ({ ...r }));
    const resB = classifyReservationZoneOccurrences(orderB, snap).results.map((r) => ({ ...r }));

    const sortByEntity = (arr: any[]) => [...arr].sort((a, b) => a.entityId - b.entityId);
    assert.deepEqual(sortByEntity(resA), sortByEntity(resB));
});

test("30b. order-independence: multiple unknown + unmatched predecessors, two orders", () => {
    const snap = snapshot({ registry: [], zones: [[10, "active"], [20, "active"]] });
    const orderA = validateReservationZoneOccurrences([occ(3, G3), occ(4, G4)]);
    const orderB = validateReservationZoneOccurrences([occ(4, G4), occ(3, G3)]);
    const resA = classifyReservationZoneOccurrences(orderA, snap).results;
    const resB = classifyReservationZoneOccurrences(orderB, snap).results;
    const sortByEntity = (arr: any[]) => [...arr].sort((a, b) => a.entityId - b.entityId);
    assert.deepEqual(sortByEntity(resA), sortByEntity(resB));
});

test("30c. order-independence: two historical GIDs resolving to one zone, two orders", () => {
    const snap = snapshot({ registry: [[G1, 10], [G2, 10]], zones: [[10, "active"]] });
    const orderA = validateReservationZoneOccurrences([occ(1, G1), occ(2, G2)]);
    const orderB = validateReservationZoneOccurrences([occ(2, G2), occ(1, G1)]);
    const resA = classifyReservationZoneOccurrences(orderA, snap).results;
    const resB = classifyReservationZoneOccurrences(orderB, snap).results;
    const sortByEntity = (arr: any[]) => [...arr].sort((a, b) => a.entityId - b.entityId);
    assert.deepEqual(sortByEntity(resA), sortByEntity(resB));
});

test("30d. order-independence: duplicate Names, two orders", () => {
    const snap = snapshot({ registry: [[G1, 10]], zones: [[10, "active"]] });
    const orderA = validateReservationZoneOccurrences([occ(1, G1, "Dup"), occ(2, G2, "Dup")]);
    const orderB = validateReservationZoneOccurrences([occ(2, G2, "Dup"), occ(1, G1, "Dup")]);
    const resA = classifyReservationZoneOccurrences(orderA, snap).results;
    const resB = classifyReservationZoneOccurrences(orderB, snap).results;
    const sortByEntity = (arr: any[]) => [...arr].sort((a, b) => a.entityId - b.entityId);
    assert.deepEqual(sortByEntity(resA), sortByEntity(resB));
});

test("30e. order-independence: identical reference-space sets, two orders", () => {
    const snap = snapshot({ registry: [], zones: [] });
    const orderA = validateReservationZoneOccurrences([occ(1, G1, "A", [G3]), occ(2, G2, "B", [G3])]);
    const orderB = validateReservationZoneOccurrences([occ(2, G2, "B", [G3]), occ(1, G1, "A", [G3])]);
    const resA = classifyReservationZoneOccurrences(orderA, snap).results;
    const resB = classifyReservationZoneOccurrences(orderB, snap).results;
    const sortByEntity = (arr: any[]) => [...arr].sort((a, b) => a.entityId - b.entityId);
    assert.deepEqual(sortByEntity(resA), sortByEntity(resB));
});

// ==================== ADDITIONAL COVERAGE ====================

test("31. IDENTITY_AMBIGUOUS diagnostic shape carries entityId/GlobalId/Name/referencedSpaceGlobalIds/candidates", () => {
    const snap = snapshot({ registry: [], zones: [[10, "active", "Predecessor"]] });
    const v = validateOne(occ(3, G3, "Incoming Name", [G4]));
    const r = classifyReservationZoneOccurrences([v], snap).results[0]! as any;
    assert.equal(r.entityId, 3);
    assert.equal(r.globalId, G3);
    assert.equal(r.name, "Incoming Name");
    assert.deepEqual(r.referencedSpaceGlobalIds, [G4]);
    assert.deepEqual(r.candidatePredecessorZoneIds, [10]);
    assert.equal(r.candidatePredecessors[0].reservationZoneId, 10);
    assert.equal(r.candidatePredecessors[0].currentName, "Predecessor");
    assert.equal(r.candidatePredecessors[0].status, "active");
});

test("32. RETIRED_IDENTITY_CONFLICT diagnostic shape carries entityId/GlobalId/reservationZoneId/status/currentName", () => {
    const snap = snapshot({ registry: [[G1, 10]], zones: [[10, "retired", "Old Zone"]] });
    const v = validateOne(occ(1, G1));
    const r = classifyReservationZoneOccurrences([v], snap).results[0]! as any;
    assert.equal(r.entityId, 1);
    assert.equal(r.globalId, G1);
    assert.equal(r.reservationZoneId, 10);
    assert.equal(r.ownerStatus, "retired");
    assert.equal(r.currentName, "Old Zone");
});

test("33. exact outcome-state set is exactly the frozen five", () => {
    const outcomes = new Set<string>([
        "REUSE_EXISTING",
        "MINT_NEW",
        "IDENTITY_AMBIGUOUS",
        "INVALID_OCCURRENCE",
        "RETIRED_IDENTITY_CONFLICT",
    ]);
    assert.equal(outcomes.size, 5);
});

test("whole-set: empty occurrence list classifies to an empty, valid result set", () => {
    const snap = snapshot({ registry: [], zones: [[10, "active"]] });
    const { results, byEntityId } = classifyReservationZoneOccurrences([], snap);
    assert.deepEqual(results, []);
    assert.equal(byEntityId.size, 0);
});

test("collision + unrelated known/unknown occurrences classify independently in the same whole-set call", () => {
    const snap = snapshot({ registry: [[G1, 10], [G2, 10], [G4, 30]], zones: [[10, "active"], [20, "active"], [30, "active"]] });
    const validated = validateReservationZoneOccurrences([occ(1, G1), occ(2, G2), occ(3, G3), occ(4, G4)]);
    const { byEntityId } = classifyReservationZoneOccurrences(validated, snap);
    assert.equal(byEntityId.get(1)!.outcome, "INVALID_OCCURRENCE");
    assert.equal(byEntityId.get(2)!.outcome, "INVALID_OCCURRENCE");
    assert.equal(byEntityId.get(4)!.outcome, "REUSE_EXISTING");
    // G3 unknown; predecessor pool = eligible(10,20,30) - matched(10,30) = {20}
    const g3 = byEntityId.get(3)! as any;
    assert.equal(g3.outcome, "IDENTITY_AMBIGUOUS");
    assert.deepEqual(g3.candidatePredecessorZoneIds, [20]);
});

test("ReservationZoneOccurrenceValidationError instances carry .reason and .diagnostics", () => {
    try {
        validateReservationZoneOccurrences([{ ...occ(1, G1), entityId: -1 }]);
        assert.fail("expected throw");
    } catch (e) {
        assert.ok(e instanceof ReservationZoneOccurrenceValidationError);
        assert.equal((e as any).reason, "invalid_entity_id");
        assert.ok((e as any).diagnostics);
    }
});

// ==================== ISSUE 1 — RESERVATIONZONE DISCRIMINATOR VALIDATION (A-I) ====================

test("A. valid literals (IfcSpatialZone/RESERVATION) accepted", () => {
    const v = validateOne(occ(1, G1));
    assert.equal(v.ifcClass, "IfcSpatialZone");
    assert.equal(v.predefinedType, "RESERVATION");
});

test("B. missing ifcClass rejected (invalid_payload_shape)", () => {
    const bad: any = { ...occ(1, G1) };
    delete bad.ifcClass;
    assert.throws(() => validateReservationZoneOccurrences([bad]), (e: any) => e.reason === "invalid_payload_shape");
});

test("C. wrong ifcClass (IfcSpace) rejected (invalid_payload_shape)", () => {
    assert.throws(
        () => validateReservationZoneOccurrences([{ ...occ(1, G1), ifcClass: "IfcSpace" }]),
        (e: any) => e.reason === "invalid_payload_shape",
    );
});

test("D. case-varied ifcClass (ifcspatialzone) rejected (invalid_payload_shape)", () => {
    assert.throws(
        () => validateReservationZoneOccurrences([{ ...occ(1, G1), ifcClass: "ifcspatialzone" }]),
        (e: any) => e.reason === "invalid_payload_shape",
    );
});

test("E. missing predefinedType rejected (invalid_payload_shape)", () => {
    const bad: any = { ...occ(1, G1) };
    delete bad.predefinedType;
    assert.throws(() => validateReservationZoneOccurrences([bad]), (e: any) => e.reason === "invalid_payload_shape");
});

test("F. predefinedType THERMAL rejected (invalid_payload_shape)", () => {
    assert.throws(
        () => validateReservationZoneOccurrences([{ ...occ(1, G1), predefinedType: "THERMAL" }]),
        (e: any) => e.reason === "invalid_payload_shape",
    );
});

test("G. predefinedType NOTDEFINED rejected (invalid_payload_shape)", () => {
    assert.throws(
        () => validateReservationZoneOccurrences([{ ...occ(1, G1), predefinedType: "NOTDEFINED" }]),
        (e: any) => e.reason === "invalid_payload_shape",
    );
});

test("H. predefinedType USERDEFINED rejected (invalid_payload_shape)", () => {
    assert.throws(
        () => validateReservationZoneOccurrences([{ ...occ(1, G1), predefinedType: "USERDEFINED" }]),
        (e: any) => e.reason === "invalid_payload_shape",
    );
});

test("I. case-varied predefinedType (reservation lowercase) rejected (invalid_payload_shape)", () => {
    assert.throws(
        () => validateReservationZoneOccurrences([{ ...occ(1, G1), predefinedType: "reservation" }]),
        (e: any) => e.reason === "invalid_payload_shape",
    );
});

test("discriminator edge cases: null discriminator and arbitrary string also rejected", () => {
    assert.throws(
        () => validateReservationZoneOccurrences([{ ...occ(1, G1), ifcClass: null }]),
        (e: any) => e.reason === "invalid_payload_shape",
    );
    assert.throws(
        () => validateReservationZoneOccurrences([{ ...occ(1, G1), predefinedType: null }]),
        (e: any) => e.reason === "invalid_payload_shape",
    );
    assert.throws(
        () => validateReservationZoneOccurrences([{ ...occ(1, G1), ifcClass: "SomethingElse" }]),
        (e: any) => e.reason === "invalid_payload_shape",
    );
    assert.throws(
        () => validateReservationZoneOccurrences([{ ...occ(1, G1), predefinedType: "SomethingElse" }]),
        (e: any) => e.reason === "invalid_payload_shape",
    );
});

test("exactly 5 outcome states remain after discriminator hardening (no 6th state introduced)", () => {
    const outcomes = new Set<string>([
        "REUSE_EXISTING",
        "MINT_NEW",
        "IDENTITY_AMBIGUOUS",
        "INVALID_OCCURRENCE",
        "RETIRED_IDENTITY_CONFLICT",
    ]);
    assert.equal(outcomes.size, 5);
});

// ==================== ISSUE 2 — EMPTY OCCURRENCE / EMPTY GLOBALID SET (J, M, N) ====================
// K, L, O (loader-level, requiring MySQL) live in
// back/scripts/reservationZoneIdentitySnapshotSelfTest.ts.

test("J. validate([]) -> []", () => {
    assert.deepEqual(validateReservationZoneOccurrences([]), []);
});

test("M. classifier([], snapshot) returns zero results, empty byEntityId", () => {
    const snap = snapshot({ registry: [], zones: [[10, "active"], [20, "absent"]] });
    const { results, byEntityId } = classifyReservationZoneOccurrences([], snap);
    assert.deepEqual(results, []);
    assert.equal(byEntityId.size, 0);
});

test("N. historical active/absent/retired zones exist but zero incoming occurrences -> zero outcomes fabricated", () => {
    // Registry also has resolvable owners in the snapshot, but there are NO
    // incoming occurrences to classify — no MINT_NEW/AMBIGUOUS/RETIRED/INVALID
    // may ever be synthesized from DB state alone.
    const snap = snapshot({
        registry: [[G1, 10], [G2, 20]],
        zones: [[10, "active"], [20, "retired"], [30, "absent"]],
    });
    const { results, byEntityId } = classifyReservationZoneOccurrences([], snap);
    assert.deepEqual(results, []);
    assert.equal(byEntityId.size, 0);
});

// ==================== ISSUE 3 — REMOVE CROSS-SCOPE OWNER FALLBACK (integrity) ====================

test("14. inconsistent snapshot (registry owner missing from lineage-scoped zone set) fails closed", () => {
    // Fabricated/mocked query results, bypassing the real DB: registry row
    // (L1, G1) -> Z99, but Z99 is NOT present in the lineage-scoped zone set.
    const registryByGlobalId = new Map<string, number>([[G1, 99]]);
    const zoneStatusById = new Map<number, "active" | "absent" | "retired">([[10, "active"]]); // no 99
    assert.throws(
        () => assertRegistryOwnersHaveLineageScopedZoneStatus(1, registryByGlobalId, zoneStatusById),
        (e: any) => {
            assert.ok(e instanceof ReservationZoneIdentitySnapshotIntegrityError);
            assert.equal(e.code, "registry_owner_missing_lineage_scoped_zone");
            assert.deepEqual(e.diagnostics.missingOwnerZoneIds, [99]);
            assert.equal(e.diagnostics.linkedModelId, 1);
            return true;
        },
    );
});

test("15b. valid snapshot (registry owner IS present in lineage-scoped zone set) succeeds unaffected", () => {
    const registryByGlobalId = new Map<string, number>([[G1, 10], [G2, 20]]);
    const zoneStatusById = new Map<number, "active" | "absent" | "retired">([[10, "active"], [20, "retired"], [30, "absent"]]);
    assert.doesNotThrow(() => assertRegistryOwnersHaveLineageScopedZoneStatus(1, registryByGlobalId, zoneStatusById));
});

test("integrity error name/instance shape matches repo structured-error convention", () => {
    try {
        assertRegistryOwnersHaveLineageScopedZoneStatus(1, new Map([[G1, 99]]), new Map());
        assert.fail("expected throw");
    } catch (e) {
        assert.ok(e instanceof Error);
        assert.ok(e instanceof ReservationZoneIdentitySnapshotIntegrityError);
        assert.equal((e as any).name, "ReservationZoneIdentitySnapshotIntegrityError");
    }
});
