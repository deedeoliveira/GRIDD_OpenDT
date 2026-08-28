import type {
    ReservationZoneClassificationResult,
    ReservationZoneClassificationSet,
    ReservationZoneIdentitySnapshot,
    ReservationZoneOwnerStatus,
    ValidatedReservationZoneOccurrence,
} from "./reservationZoneIdentityTypes.ts";

/**
 * RZ-2B1 — PURE ReservationZone identity classifier (RZ-GID-POLICY-B, frozen).
 *
 * Deterministic function of (validated occurrence set + frozen authoritative
 * snapshot). NEVER calls MySQL. NEVER writes. Operates on the ENTIRE incoming
 * occurrence set at once and is order-independent (§ALGORITHM step 10).
 *
 * ------------------------------------------------------------------
 * Algorithm (verbatim from the frozen spec):
 *  1. Accept only structurally validated occurrences (caller's responsibility —
 *     see reservationZoneIdentityValidator.ts).
 *  2. Resolve each occurrence's GlobalId against the supplied registry snapshot.
 *  3. Build an occurrence-level mapping: incoming occurrence -> known
 *     reservation_zone_id OR unknown. Never collapses immediately to a Set.
 *  4. Detect two or more DISTINCT incoming occurrences resolving to the SAME
 *     known reservation_zone_id -> blocking INVALID_OCCURRENCE,
 *     multiple_manifestations_same_identity (applies to ALL occurrences
 *     participating in that collision).
 *  5. Inspect status of every known owner: active/absent -> REUSE_EXISTING;
 *     retired -> RETIRED_IDENTITY_CONFLICT.
 *  6. Build MATCHED_EXISTING_ZONES from known occurrence->zone mappings
 *     (deduplicated: a zone with multiple owning GlobalIds counts once).
 *  7. Build ELIGIBLE_HISTORICAL_ZONES: lineage zones with status active or
 *     absent only (retired zones excluded).
 *  8. Compute ONE frozen whole-set: UNMATCHED_PREDECESSORS = eligible - matched.
 *  9. Classify EVERY unknown occurrence against the SAME frozen pool: empty ->
 *     MINT_NEW; nonempty -> IDENTITY_AMBIGUOUS. One unknown occurrence never
 *     consumes/changes the predecessor pool before another is classified (no
 *     greedy pairing, no mint-one-reconcile-the-other by iteration order).
 *  10. Result is stable/deterministic, independent of occurrence ordering.
 * ------------------------------------------------------------------
 */
export function classifyReservationZoneOccurrences(
    validatedOccurrences: ValidatedReservationZoneOccurrence[],
    identitySnapshot: ReservationZoneIdentitySnapshot,
): ReservationZoneClassificationSet {
    // Step 2/3: resolve each occurrence against the registry snapshot, WITHOUT
    // collapsing to a Set yet — collect the full occurrence-level mapping first.
    const resolved = validatedOccurrences.map((occ) => ({
        occ,
        zoneId: identitySnapshot.registryByGlobalId.get(occ.globalId) ?? null,
    }));

    // Step 4: multiple DISTINCT incoming occurrences -> same known zone id.
    const byZoneId = new Map<number, typeof resolved>();
    for (const entry of resolved) {
        if (entry.zoneId === null) continue;
        const group = byZoneId.get(entry.zoneId) ?? [];
        group.push(entry);
        byZoneId.set(entry.zoneId, group);
    }
    const collidingEntityIds = new Set<number>();
    const collisionReservationZoneIdByEntityId = new Map<number, number>();
    const collisionSiblingsByEntityId = new Map<number, number[]>();
    for (const [zoneId, group] of byZoneId) {
        if (group.length < 2) continue;
        const entityIds = group.map((g) => g.occ.entityId);
        for (const g of group) {
            collidingEntityIds.add(g.occ.entityId);
            collisionReservationZoneIdByEntityId.set(g.occ.entityId, zoneId);
            collisionSiblingsByEntityId.set(g.occ.entityId, entityIds.filter((id) => id !== g.occ.entityId));
        }
    }

    // Step 6: MATCHED_EXISTING_ZONES — deduplicated known occurrence->zone ids,
    // EXCLUDING colliding occurrences' zones is NOT required by the spec — a
    // zone matched by a valid known occurrence is still "matched" even if it
    // also happens to collide; the collision itself is reported separately as
    // INVALID_OCCURRENCE for those specific occurrences. We still include such
    // zone ids in MATCHED_EXISTING_ZONES because the historical GlobalId(s)
    // genuinely own that zone.
    const matchedExistingZones = new Set<number>();
    for (const entry of resolved) {
        if (entry.zoneId !== null) matchedExistingZones.add(entry.zoneId);
    }

    // Step 7: ELIGIBLE_HISTORICAL_ZONES — status active or absent only.
    const eligibleHistoricalZones = new Set<number>();
    for (const [zoneId, status] of identitySnapshot.zoneStatusById) {
        if (status === "active" || status === "absent") eligibleHistoricalZones.add(zoneId);
    }

    // Step 8: ONE frozen whole-set, computed once, reused for every unknown occurrence.
    const unmatchedPredecessors = [...eligibleHistoricalZones].filter((z) => !matchedExistingZones.has(z));

    const results: ReservationZoneClassificationResult[] = [];
    const byEntityId = new Map<number, ReservationZoneClassificationResult>();

    for (const entry of resolved) {
        const { occ, zoneId } = entry;

        // Step 4 result: blocking collision — takes precedence for these occurrences.
        if (collidingEntityIds.has(occ.entityId)) {
            const result: ReservationZoneClassificationResult = {
                outcome: "INVALID_OCCURRENCE",
                reason: "multiple_manifestations_same_identity",
                entityId: occ.entityId,
                globalId: occ.globalId,
                reservationZoneId: collisionReservationZoneIdByEntityId.get(occ.entityId),
                conflictingEntityIds: collisionSiblingsByEntityId.get(occ.entityId) ?? [],
            };
            results.push(result);
            byEntityId.set(occ.entityId, result);
            continue;
        }

        if (zoneId !== null) {
            // Step 5: known GlobalId — lifecycle by owner status.
            const status: ReservationZoneOwnerStatus | undefined = identitySnapshot.zoneStatusById.get(zoneId);
            if (status === "retired") {
                const result: ReservationZoneClassificationResult = {
                    outcome: "RETIRED_IDENTITY_CONFLICT",
                    entityId: occ.entityId,
                    globalId: occ.globalId,
                    reservationZoneId: zoneId,
                    ownerStatus: "retired",
                    currentName: identitySnapshot.zoneCurrentNameById?.get(zoneId),
                };
                results.push(result);
                byEntityId.set(occ.entityId, result);
                continue;
            }
            // active or absent (or unrecorded, treated as absent-equivalent per
            // "Registry hit identifies the persistent identity authoritatively" —
            // status must have been loaded by the snapshot loader for every
            // registry-resolved owner; a missing status is a caller/loader bug,
            // never silently coerced to a favourable outcome here).
            const ownerStatus: "active" | "absent" = status === "active" ? "active" : "absent";
            const result: ReservationZoneClassificationResult = {
                outcome: "REUSE_EXISTING",
                entityId: occ.entityId,
                globalId: occ.globalId,
                reservationZoneId: zoneId,
                ownerStatus,
            };
            results.push(result);
            byEntityId.set(occ.entityId, result);
            continue;
        }

        // Step 9: unknown GlobalId — classify against the SAME frozen pool.
        if (unmatchedPredecessors.length === 0) {
            const result: ReservationZoneClassificationResult = {
                outcome: "MINT_NEW",
                entityId: occ.entityId,
                globalId: occ.globalId,
            };
            results.push(result);
            byEntityId.set(occ.entityId, result);
        } else {
            const result: ReservationZoneClassificationResult = {
                outcome: "IDENTITY_AMBIGUOUS",
                entityId: occ.entityId,
                globalId: occ.globalId,
                name: occ.name,
                referencedSpaceGlobalIds: [...occ.referencedSpaceGlobalIds],
                candidatePredecessorZoneIds: [...unmatchedPredecessors].sort((a, b) => a - b),
                candidatePredecessors: [...unmatchedPredecessors].sort((a, b) => a - b).map((zid) => ({
                    reservationZoneId: zid,
                    currentName: identitySnapshot.zoneCurrentNameById?.get(zid),
                    status: identitySnapshot.zoneStatusById.get(zid) as ReservationZoneOwnerStatus,
                })),
            };
            results.push(result);
            byEntityId.set(occ.entityId, result);
        }
    }

    // Step 10: stable, order-independent presentation order — sort by entityId.
    // (byEntityId map already gives O(1) lookup independent of insertion order;
    // `results` is additionally re-sorted so two callers presenting different
    // input orders observe an identical `results` array.)
    results.sort((a, b) => (a.entityId ?? -1) - (b.entityId ?? -1));

    return { results, byEntityId };
}
