import { isValidIfcGlobalId, ifcGlobalIdInvalidReason } from "../utils/ifcGlobalId.ts";
import type {
    InvalidReservationZoneOccurrenceReason,
    RawReservationZoneOccurrence,
    ValidatedReservationZoneOccurrence,
} from "./reservationZoneIdentityTypes.ts";

/**
 * RZ-2B1 — PURE structural validator for the `reservationZoneOccurrences`
 * contract (RZ-1 extraction, RZ-GID-POLICY-B). No database access, no writes.
 *
 * Name is mandatory operational metadata but is NEVER identity: this
 * validator only establishes presence/non-blankness, it never canonicalizes
 * Name into an identity key, never compares Name across occurrences to
 * decide REUSE/MINT/AMBIGUOUS, and never requires Name uniqueness.
 *
 * GlobalId semantics are EXACT / case-sensitive: no trimming, no case
 * folding, matching `^[0-9A-Za-z_$]{22}$` (identical to the compressed IFC
 * GUID rule used by spaces.ifc_global_id / reservation_zone_guid_registry).
 */
export class ReservationZoneOccurrenceValidationError extends Error {
    readonly reason: InvalidReservationZoneOccurrenceReason;
    readonly diagnostics: any;
    constructor(reason: InvalidReservationZoneOccurrenceReason, message: string, diagnostics: any = null) {
        super(message);
        this.name = "ReservationZoneOccurrenceValidationError";
        this.reason = reason;
        this.diagnostics = diagnostics;
    }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate ONE occurrence's structural shape (ifcClass, predefinedType,
 * entityId, globalId, Name, referencedSpaceGlobalIds). Throws
 * {@link ReservationZoneOccurrenceValidationError} on the FIRST structural
 * defect found for that occurrence (deterministic order: shape -> ifcClass ->
 * predefinedType -> entityId -> globalId -> name -> referencedSpaceGlobalIds).
 *
 * ifcClass/predefinedType are the frozen RZ-1 discriminators: only the EXACT
 * literals "IfcSpatialZone" / "RESERVATION" are accepted (no case-folding, no
 * normalization) — anything else (wrong class, wrong PredefinedType, missing,
 * null, or case-varied) is rejected as invalid_payload_shape, before the
 * occurrence ever reaches entityId/globalId checks or the classifier.
 */
function validateOneOccurrence(raw: unknown, index: number): ValidatedReservationZoneOccurrence {
    if (!isPlainObject(raw)) {
        throw new ReservationZoneOccurrenceValidationError(
            "invalid_payload_shape",
            `reservationZoneOccurrences[${index}] is not a plain object.`,
            { index },
        );
    }

    const ifcClass = raw.ifcClass;
    if (ifcClass !== "IfcSpatialZone") {
        throw new ReservationZoneOccurrenceValidationError(
            "invalid_payload_shape",
            `reservationZoneOccurrences[${index}] has an unrecognized ifcClass; only the exact literal "IfcSpatialZone" is a ReservationZone occurrence.`,
            { index, ifcClass: typeof ifcClass === "string" ? ifcClass : null },
        );
    }

    const predefinedType = raw.predefinedType;
    if (predefinedType !== "RESERVATION") {
        throw new ReservationZoneOccurrenceValidationError(
            "invalid_payload_shape",
            `reservationZoneOccurrences[${index}] has an unrecognized predefinedType; only the exact literal "RESERVATION" is a ReservationZone occurrence.`,
            { index, predefinedType: typeof predefinedType === "string" ? predefinedType : null },
        );
    }

    const entityId = raw.entityId;
    if (entityId === null || entityId === undefined || typeof entityId !== "number" || !Number.isSafeInteger(entityId) || entityId <= 0) {
        throw new ReservationZoneOccurrenceValidationError(
            "invalid_entity_id",
            `reservationZoneOccurrences[${index}] has a missing or invalid entityId; a positive safe integer is required.`,
            { index, entityId: entityId ?? null },
        );
    }

    const globalId = raw.globalId;
    if (typeof globalId !== "string" || !isValidIfcGlobalId(globalId)) {
        throw new ReservationZoneOccurrenceValidationError(
            "invalid_global_id",
            `reservationZoneOccurrences[${index}] (entityId ${entityId}) has a missing or malformed GlobalId (expected ^[0-9A-Za-z_$]{22}$).`,
            { index, entityId, globalId: typeof globalId === "string" ? globalId : null, reason: ifcGlobalIdInvalidReason(globalId) },
        );
    }

    const name = raw.name;
    if (name === null || name === undefined || typeof name !== "string" || name.trim().length === 0) {
        throw new ReservationZoneOccurrenceValidationError(
            "invalid_name",
            `reservationZoneOccurrences[${index}] (entityId ${entityId}, GlobalId ${globalId}) has a missing or blank Name; Name is mandatory operational metadata (never identity).`,
            { index, entityId, globalId, name: typeof name === "string" ? name : null },
        );
    }

    const refs = raw.referencedSpaceGlobalIds;
    if (!Array.isArray(refs)) {
        throw new ReservationZoneOccurrenceValidationError(
            "invalid_referenced_space_global_ids",
            `reservationZoneOccurrences[${index}] (entityId ${entityId}, GlobalId ${globalId}) has a non-array referencedSpaceGlobalIds.`,
            { index, entityId, globalId },
        );
    }
    for (let i = 0; i < refs.length; i++) {
        const member = refs[i];
        if (typeof member !== "string" || member.trim().length === 0) {
            throw new ReservationZoneOccurrenceValidationError(
                "invalid_referenced_space_global_ids",
                `reservationZoneOccurrences[${index}] (entityId ${entityId}, GlobalId ${globalId}) has a non-string or blank referencedSpaceGlobalIds member at position ${i}.`,
                { index, entityId, globalId, memberIndex: i, member },
            );
        }
    }

    return {
        entityId,
        globalId,
        name,
        referencedSpaceGlobalIds: [...refs] as string[],
        ifcClass: ifcClass as "IfcSpatialZone",
        predefinedType: predefinedType as "RESERVATION",
    };
}

/**
 * Validate the WHOLE incoming `reservationZoneOccurrences` set (pure, no DB).
 *
 * Order (each blocking, first failure wins across the whole set):
 *  1. top-level field must be an array (invalid_payload_shape);
 *  2. every element structurally valid (validateOneOccurrence, per-element order
 *     above: shape, entityId, globalId, name, referencedSpaceGlobalIds);
 *  3. no duplicate entityId anywhere in the set (duplicate_entity_id);
 *  4. no duplicate EXACT (case-sensitive) globalId anywhere in the set
 *     (duplicate_global_id).
 *
 * Returns the validated, order-preserved occurrence list. Order-independence is
 * a property of the CLASSIFIER, not the validator — this function does not sort.
 */
export function validateReservationZoneOccurrences(input: unknown): ValidatedReservationZoneOccurrence[] {
    if (input === undefined || input === null) {
        throw new ReservationZoneOccurrenceValidationError(
            "invalid_payload_shape",
            "reservationZoneOccurrences is required for ReservationZone identity classification but was absent/null.",
            {},
        );
    }
    if (!Array.isArray(input)) {
        throw new ReservationZoneOccurrenceValidationError(
            "invalid_payload_shape",
            "reservationZoneOccurrences must be an array.",
            {},
        );
    }

    const rawList = input as RawReservationZoneOccurrence[];
    const validated: ValidatedReservationZoneOccurrence[] = rawList.map((el, i) => validateOneOccurrence(el, i));

    // Duplicate entityId (whole-set).
    const entityIdSeen = new Map<number, number>(); // entityId -> first index
    for (let i = 0; i < validated.length; i++) {
        const id = validated[i]!.entityId;
        if (entityIdSeen.has(id)) {
            throw new ReservationZoneOccurrenceValidationError(
                "duplicate_entity_id",
                `Duplicate entityId ${id} appears in multiple reservationZoneOccurrences (indices ${entityIdSeen.get(id)} and ${i}).`,
                { entityId: id, indices: [entityIdSeen.get(id), i] },
            );
        }
        entityIdSeen.set(id, i);
    }

    // Duplicate exact (case-sensitive) globalId (whole-set) — NEVER case-folded.
    const globalIdSeen = new Map<string, number>();
    for (let i = 0; i < validated.length; i++) {
        const gid = validated[i]!.globalId;
        if (globalIdSeen.has(gid)) {
            throw new ReservationZoneOccurrenceValidationError(
                "duplicate_global_id",
                `Duplicate exact GlobalId '${gid}' appears in multiple reservationZoneOccurrences (indices ${globalIdSeen.get(gid)} and ${i}).`,
                { globalId: gid, indices: [globalIdSeen.get(gid), i] },
            );
        }
        globalIdSeen.set(gid, i);
    }

    return validated;
}
