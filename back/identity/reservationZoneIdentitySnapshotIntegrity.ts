import type { ReservationZoneOwnerStatus } from "./reservationZoneIdentityTypes.ts";

/**
 * RZ-2B1 V2 — PURE snapshot-assembly integrity check (no database access).
 *
 * Extracted from back/utils/reservationZoneIdentityDatabase.ts so this
 * fail-closed assembly logic is unit-testable against fabricated/mocked
 * query results, independent of any real database connection (the DB loader
 * module has a module-load-time side effect — constructing its MySQL pool —
 * that requires DB_* env vars to be present, which pure unit tests must not
 * depend on).
 *
 * Thrown when a registry-resolved owner's reservation_zone_id is absent from
 * the lineage-scoped `reservation_zones` query for the SAME linked_model_id.
 * The A1 schema's composite FK (fk_rzgr_zone_lineage: (linked_model_id,
 * reservation_zone_id) -> reservation_zones(linked_model_id, id)) makes this
 * structurally impossible in a properly-migrated database — so this
 * indicates corrupt/impossible DB state, disabled FK integrity, or a
 * query/programming defect, NOT a normal runtime condition and NOT one of
 * the 5 classifier outcomes. The whole snapshot load fails closed; nothing
 * is classified.
 */
export class ReservationZoneIdentitySnapshotIntegrityError extends Error {
    readonly code: "registry_owner_missing_lineage_scoped_zone";
    readonly diagnostics: any;
    constructor(code: "registry_owner_missing_lineage_scoped_zone", message: string, diagnostics: any = null) {
        super(message);
        this.name = "ReservationZoneIdentitySnapshotIntegrityError";
        this.code = code;
        this.diagnostics = diagnostics;
    }
}

/**
 * Given the registry->zone ownership map and the lineage-scoped zone-status
 * map already loaded by the loader's (A) and (B) steps, verify every
 * registry-resolved owner has a matching lineage-scoped zone-status entry.
 * Throws {@link ReservationZoneIdentitySnapshotIntegrityError} and fails the
 * whole snapshot assembly closed if not.
 *
 * Does NOT recover via a cross-scope (missing-linked_model_id) fallback
 * query, NOT silently omit the owner, and NOT classify it as "unknown" —
 * the persisted authority itself would be internally inconsistent, a
 * different failure category than any of the 5 classifier outcomes (which
 * only describe incoming IFC evidence).
 */
export function assertRegistryOwnersHaveLineageScopedZoneStatus(
    linkedModelId: number,
    registryByGlobalId: Map<string, number>,
    zoneStatusById: Map<number, ReservationZoneOwnerStatus>,
): void {
    const missingOwnerZoneIds = [...new Set(registryByGlobalId.values())].filter((id) => !zoneStatusById.has(id));
    if (missingOwnerZoneIds.length > 0) {
        throw new ReservationZoneIdentitySnapshotIntegrityError(
            "registry_owner_missing_lineage_scoped_zone",
            `ReservationZone identity snapshot for linkedModelId ${linkedModelId} is internally inconsistent: ` +
                `registry-resolved reservation_zone_id(s) [${missingOwnerZoneIds.join(", ")}] have no matching row in the ` +
                `lineage-scoped reservation_zones query. This should be structurally impossible under the A1 composite FK ` +
                `(fk_rzgr_zone_lineage) and indicates corrupt/inconsistent DB state; refusing to classify.`,
            { linkedModelId, missingOwnerZoneIds },
        );
    }
}
