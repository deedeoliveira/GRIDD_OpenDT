/**
 * Shared application-level validator for an IFC compressed GlobalId (ADR-0051,
 * Stage 0B §1). This is the FIRST line of validation for persistent IfcSpace
 * identity — used by model-intake preflight, duplicate candidate grouping,
 * preview classification, persistent identity resolution, persistent-space
 * creation and binding creation, so every path enforces the same rule.
 *
 * Accepted form (exactly): ^[0-9A-Za-z_$]{22}$
 *  - exactly 22 ASCII characters;
 *  - alphabet limited to 0-9 A-Z a-z _ $ (the IFC base64 variant);
 *  - case is significant and preserved (two GlobalIds differing only by case are
 *    distinct — see the ascii_bin canonical index);
 *  - NO trimming: leading/trailing whitespace is NOT silently stripped, so a
 *    padded value is invalid rather than being coerced into a valid one;
 *  - NO Unicode lookalikes: the character class is ASCII-only;
 *  - NO Reference fallback: an invalid GlobalId is blocking.
 *
 * The Stage 0A database CHECK (chk_spaces_ifc_global_id_format) remains the
 * final defence in depth on INSERT; this validator ensures the application never
 * reaches a write with an invalid candidate.
 */
export const IFC_GLOBAL_ID_PATTERN = /^[0-9A-Za-z_$]{22}$/;

/** True iff `value` is a syntactically valid IFC compressed GlobalId. */
export function isValidIfcGlobalId(value: unknown): value is string {
    return typeof value === "string" && IFC_GLOBAL_ID_PATTERN.test(value);
}

export type IfcGlobalIdInvalidReason =
    | "missing"          // null / undefined / not a string
    | "empty"            // "" or whitespace-only
    | "whitespace"       // otherwise-valid content surrounded by whitespace
    | "length"           // wrong number of characters
    | "alphabet";        // a disallowed character

/**
 * Precise reason an IFC GlobalId is invalid, for operational diagnostics. Never
 * returns a "valid" — call {@link isValidIfcGlobalId} for the boolean gate.
 */
export function ifcGlobalIdInvalidReason(value: unknown): IfcGlobalIdInvalidReason | null {
    if (isValidIfcGlobalId(value)) return null;
    if (typeof value !== "string") return "missing";
    if (value.trim().length === 0) return "empty";
    // Distinguish "would be valid if not padded" from a genuinely malformed core.
    if (value.trim() !== value && IFC_GLOBAL_ID_PATTERN.test(value.trim())) return "whitespace";
    if (value.length !== 22) return "length";
    return "alphabet";
}
