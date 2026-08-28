import MySQLDatabase from "./mysqlDatabase.ts";
import { isValidIfcGlobalId } from "./ifcGlobalId.ts";
import type { ReservationZoneIdentitySnapshot, ReservationZoneOwnerStatus } from "../identity/reservationZoneIdentityTypes.ts";
import {
    assertRegistryOwnersHaveLineageScopedZoneStatus,
    ReservationZoneIdentitySnapshotIntegrityError,
} from "../identity/reservationZoneIdentitySnapshotIntegrity.ts";

/**
 * RZ-2B1 — narrow, EXPLICITLY READ-ONLY ReservationZone identity snapshot
 * loader. Loads exactly what the pure classifier needs and nothing else.
 *
 * Forbidden here (RZ-2B2 territory, not this slice): createReservationZone,
 * insertRegistryClaim, insertBinding, insertSpaceReference, updateCurrentName,
 * restoreCurrentName, deleteAnything. This module contains ZERO
 * INSERT/UPDATE/DELETE statements.
 *
 * The registry (reservation_zone_guid_registry) is the SOLE ownership
 * authority (RZ-GID-POLICY-B). reservation_zone_bindings is intentionally
 * NEVER queried here for ownership resolution — it is manifestation/
 * provenance history only, never a fallback ownership source.
 */
class ReservationZoneIdentityDatabase {
    private db: MySQLDatabase;

    constructor() {
        this.db = new MySQLDatabase();
        this.db.connect();
    }

    /**
     * Load the full identity authority snapshot for ONE lineage
     * (linkedModelId), scoped to the incoming valid GlobalIds.
     *
     *  (A) registry ownership rows for the incoming valid GlobalIds:
     *      ifc_guid, reservation_zone_id — batch query, lineage-scoped.
     *  (B) all eligible historical zones for the lineage: id, status
     *      (active/absent only feed ELIGIBLE_HISTORICAL_ZONES; the loader
     *      still records every returned zone's real status).
     *  (C) status for every registry-resolved owner, INCLUDING retired
     *      owners — a retired owner's zone may not be one of (B)'s eligible
     *      rows (retired is excluded from (B) by definition), so it is
     *      fetched explicitly by id.
     *
     * Read-only: SELECT statements only.
     */
    async loadReservationZoneIdentitySnapshot(input: {
        linkedModelId: number;
        incomingGlobalIds: string[];
    }): Promise<ReservationZoneIdentitySnapshot> {
        const { linkedModelId } = input;
        const validGlobalIds = [...new Set(input.incomingGlobalIds.filter((g) => isValidIfcGlobalId(g)))];

        await this.db.checkConnection();

        const registryByGlobalId = new Map<string, number>();
        if (validGlobalIds.length > 0) {
            // (A) batch registry lookup — one query for every incoming GlobalId,
            // not one query per occurrence.
            const placeholders = validGlobalIds.map(() => "?").join(", ");
            const [registryRows]: any = await this.db.connection.execute(
                `SELECT ifc_guid, reservation_zone_id
                   FROM reservation_zone_guid_registry
                  WHERE linked_model_id = ?
                    AND BINARY ifc_guid IN (${placeholders})`,
                [linkedModelId, ...validGlobalIds],
            );
            for (const row of registryRows as any[]) {
                registryByGlobalId.set(String(row.ifc_guid), Number(row.reservation_zone_id));
            }
        }

        const zoneStatusById = new Map<number, ReservationZoneOwnerStatus>();
        const zoneCurrentNameById = new Map<number, string>();

        // (B) all eligible-historical-candidate zones for this lineage: EVERY
        // zone of the lineage, so the classifier can correctly derive
        // ELIGIBLE_HISTORICAL_ZONES (active/absent) and exclude retired ones.
        const [lineageZoneRows]: any = await this.db.connection.execute(
            `SELECT id, status, current_name
               FROM reservation_zones
              WHERE linked_model_id = ?`,
            [linkedModelId],
        );
        for (const row of lineageZoneRows as any[]) {
            zoneStatusById.set(Number(row.id), row.status as ReservationZoneOwnerStatus);
            zoneCurrentNameById.set(Number(row.id), String(row.current_name));
        }

        // (C) integrity check: EVERY registry-resolved owner (including retired
        // owners) MUST already have a status from (B)'s lineage-scoped query. The
        // A1 schema's composite FK (fk_rzgr_zone_lineage) structurally guarantees
        // that a registry row scoped to this linkedModelId can only reference a
        // reservation_zones row with the SAME linked_model_id — so a missing
        // status here is never a legitimate runtime state. It is NOT recovered
        // via a cross-scope (missing-linked_model_id) fallback query, NOT
        // silently omitted, and NOT classified as "unknown": the whole snapshot
        // load fails closed, because the persisted authority itself would be
        // internally inconsistent (a different failure category than any of the
        // 5 classifier outcomes, which only describe incoming IFC evidence).
        assertRegistryOwnersHaveLineageScopedZoneStatus(linkedModelId, registryByGlobalId, zoneStatusById);

        return { linkedModelId, registryByGlobalId, zoneStatusById, zoneCurrentNameById };
    }
}

export default new ReservationZoneIdentityDatabase();
export { ReservationZoneIdentityDatabase, ReservationZoneIdentitySnapshotIntegrityError, assertRegistryOwnersHaveLineageScopedZoneStatus };
