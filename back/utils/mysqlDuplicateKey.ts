/**
 * Structured interpretation of a mysql2 duplicate-key (ER_DUP_ENTRY) error
 * (ADR-0051, Stage 0B §5). The classification is driven by the driver's
 * STRUCTURED properties (code / errno / sqlState) plus the index name MySQL
 * embeds in the message — never by matching free English prose, and never
 * treating every ER_DUP_ENTRY as the same thing.
 *
 * mysql2 exposes: error.code = 'ER_DUP_ENTRY', error.errno = 1062,
 * error.sqlState = '23000', and error.sqlMessage = "Duplicate entry '<v>' for
 * key '<table>.<index>'". The driver does NOT surface the index name as its own
 * field, so a single narrowly-scoped parse of `for key '...'` is unavoidable;
 * it is confined here and validated against the structured code first.
 */

/** Names of the two indexes Stage 0B must tell apart. */
export const CANONICAL_GLOBALID_INDEX = "uq_spaces_linked_model_ifc_global_id";
export const LEGACY_SCOPE_INDEX = "uq_spaces_scope_code";

/** True iff `error` is a MySQL duplicate-key error (by structured code/errno). */
export function isDuplicateKeyError(error: any): boolean {
    return error?.code === "ER_DUP_ENTRY" || error?.errno === 1062;
}

/**
 * The bare index name from a duplicate-key error, or null when the error is not
 * a duplicate-key or the driver did not embed a parseable key. MySQL 8 qualifies
 * the key as `<table>.<index>`; the table qualifier is stripped.
 */
export function duplicateKeyIndexName(error: any): string | null {
    if (!isDuplicateKeyError(error)) return null;
    const message = String(error?.sqlMessage ?? error?.message ?? "");
    const match = /for key '([^']+)'/i.exec(message);
    if (!match) return null;
    const raw = match[1]!;
    const dot = raw.lastIndexOf(".");
    return dot >= 0 ? raw.slice(dot + 1) : raw;
}

export type DuplicateKeyKind =
    | "canonical_globalid"   // uq_spaces_linked_model_ifc_global_id → same identity race
    | "legacy_reference"     // uq_spaces_scope_code → transitional Reference collision
    | "unrelated"            // some other unique index → not identity/Reference
    | "not_duplicate";       // not a duplicate-key error at all

/**
 * Classify a persistence error for the Stage 0B write path. Only the canonical
 * GlobalId index is a canonical-identity race; only the legacy scope index is a
 * transitional Reference collision; any other duplicate key is UNRELATED and must
 * not be misread as either. Never falls back to Reference.
 */
export function classifyDuplicateKey(error: any): DuplicateKeyKind {
    if (!isDuplicateKeyError(error)) return "not_duplicate";
    const index = duplicateKeyIndexName(error);
    if (index === CANONICAL_GLOBALID_INDEX) return "canonical_globalid";
    if (index === LEGACY_SCOPE_INDEX) return "legacy_reference";
    return "unrelated";
}
