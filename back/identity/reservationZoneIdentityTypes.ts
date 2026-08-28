/**
 * RZ-2B1 — shared types for ReservationZone identity classification.
 *
 * Source occurrence: IfcSpatialZone, PredefinedType = RESERVATION (RZ-1
 * extraction contract, exactly 6 fields: entityId, globalId, ifcClass, name,
 * predefinedType, referencedSpaceGlobalIds — see
 * back/tests/spaces/reservationZoneOccurrencesContract.test.ts).
 *
 * Persistent identity is `reservation_zone_uuid` (application-minted, RZ-2A1
 * schema). GlobalId is manifestation/continuity evidence, never identity.
 * Name and referencedSpaceGlobalIds are mandatory operational/candidate
 * evidence — NEVER identity.
 */

/** A single RZ-1-extracted IfcSpatialZone (PredefinedType=RESERVATION) occurrence, as received. */
export interface RawReservationZoneOccurrence {
    entityId?: unknown;
    globalId?: unknown;
    ifcClass?: unknown;
    name?: unknown;
    predefinedType?: unknown;
    referencedSpaceGlobalIds?: unknown;
}

/** A structurally validated ReservationZone occurrence — safe to classify. */
export interface ValidatedReservationZoneOccurrence {
    entityId: number;
    globalId: string;
    name: string;
    referencedSpaceGlobalIds: string[];
    /**
     * Frozen RZ-1 discriminators. Verified by the validator to be the EXACT
     * literals below (no case-folding) before an occurrence is considered
     * structurally valid; preserved here verbatim for diagnostics only —
     * never re-inspected for identity by the classifier.
     */
    ifcClass: "IfcSpatialZone";
    predefinedType: "RESERVATION";
}

/** RZ-GID-POLICY-B lifecycle status of a persistent ReservationZone owner. */
export type ReservationZoneOwnerStatus = "active" | "absent" | "retired";

/**
 * Read-only, DB-derived authority snapshot the pure classifier is a
 * deterministic function of. Built by loadReservationZoneIdentitySnapshot
 * for exactly ONE lineage (linkedModelId).
 */
export interface ReservationZoneIdentitySnapshot {
    linkedModelId: number;
    /**
     * Registry ownership rows for the incoming valid GlobalIds ONLY
     * (reservation_zone_guid_registry: ifc_guid -> reservation_zone_id),
     * scoped to this lineage. The registry is the SOLE ownership authority —
     * bindings are never consulted for ownership resolution.
     */
    registryByGlobalId: Map<string, number>;
    /**
     * Status of every zone that is either (a) eligible historical (this
     * lineage's zones with status active/absent) or (b) a registry-resolved
     * owner for an incoming GlobalId, INCLUDING retired owners.
     */
    zoneStatusById: Map<number, ReservationZoneOwnerStatus>;
    /** Optional current_name, for diagnostics only — never load-bearing for identity. */
    zoneCurrentNameById?: Map<number, string>;
}

/** Final conceptual outcome categories (frozen). */
export type ReservationZoneClassificationOutcome =
    | "REUSE_EXISTING"
    | "MINT_NEW"
    | "IDENTITY_AMBIGUOUS"
    | "INVALID_OCCURRENCE"
    | "RETIRED_IDENTITY_CONFLICT";

/** Structured INVALID_OCCURRENCE reason/code set (frozen semantic distinctions). */
export type InvalidReservationZoneOccurrenceReason =
    | "invalid_payload_shape"
    | "invalid_entity_id"
    | "duplicate_entity_id"
    | "invalid_global_id"
    | "duplicate_global_id"
    | "invalid_name"
    | "invalid_referenced_space_global_ids"
    | "multiple_manifestations_same_identity";

export interface ReservationZoneReuseResult {
    outcome: "REUSE_EXISTING";
    entityId: number;
    globalId: string;
    reservationZoneId: number;
    ownerStatus: "active" | "absent";
}

export interface ReservationZoneMintResult {
    outcome: "MINT_NEW";
    entityId: number;
    globalId: string;
}

export interface ReservationZoneAmbiguousResult {
    outcome: "IDENTITY_AMBIGUOUS";
    entityId: number;
    globalId: string;
    name: string;
    referencedSpaceGlobalIds: string[];
    /** UNMATCHED_PREDECESSORS at the time of classification (frozen whole-set). */
    candidatePredecessorZoneIds: number[];
    candidatePredecessors?: Array<{ reservationZoneId: number; currentName?: string | undefined; status: ReservationZoneOwnerStatus }>;
}

export interface ReservationZoneRetiredConflictResult {
    outcome: "RETIRED_IDENTITY_CONFLICT";
    entityId: number;
    globalId: string;
    reservationZoneId: number;
    ownerStatus: "retired";
    currentName?: string | undefined;
}

export interface ReservationZoneInvalidOccurrenceResult {
    outcome: "INVALID_OCCURRENCE";
    reason: InvalidReservationZoneOccurrenceReason;
    entityId: number | null;
    globalId: string | null;
    /** Present only for multiple_manifestations_same_identity. */
    reservationZoneId?: number | undefined;
    /** Present only for multiple_manifestations_same_identity: the other colliding occurrence(s). */
    conflictingEntityIds?: number[] | undefined;
}

export type ReservationZoneClassificationResult =
    | ReservationZoneReuseResult
    | ReservationZoneMintResult
    | ReservationZoneAmbiguousResult
    | ReservationZoneRetiredConflictResult
    | ReservationZoneInvalidOccurrenceResult;

/** Stable, order-independent classification of a whole incoming occurrence set. */
export interface ReservationZoneClassificationSet {
    results: ReservationZoneClassificationResult[];
    /** results, keyed by entityId, for O(1) lookup — same content as `results`. */
    byEntityId: Map<number, ReservationZoneClassificationResult>;
}
