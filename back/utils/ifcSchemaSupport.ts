/**
 * IFC4x3-only application profile gate (ADR-0052 §A).
 *
 * The operational profile accepts ONLY the verified IFC4x3 family and rejects IFC2X3 and
 * IFC4 with an explicit unsupported-schema result. The rule is a PRECISE allowlist of the
 * schema identifiers the installed IfcOpenShell / application profile actually supports —
 * NOT a loose `startsWith("IFC4X3")`, so invented values like `IFC4X3_FAKE` /
 * `IFC4X3_ATTACK` are rejected. The supported set is exactly the four IFC4x3 releases the
 * installed IfcOpenShell 0.8 toolchain can actually parse:
 *   - IFC4X3, IFC4X3_ADD1, IFC4X3_ADD2, IFC4X3_TC1.
 * Pre-release IFC4X3_RC<number> forms are DELIBERATELY NOT accepted: IfcOpenShell 0.8
 * raises SchemaError on them, so admitting them would advertise a variant the toolchain
 * cannot process. IFC4X3_RC1 (and any other IFC4X3_* variant such as IFC4X3_ADD3) is
 * `unsupported_other`, classified BEFORE the bare `IFC4` branch so it is never mislabelled
 * `unsupported_ifc4`.
 *
 * This mirrors the Python `classify_ifc_schema` in ifcopenshell_utils.py EXACTLY so both
 * sides of the extraction boundary share one policy — there are never two subtly
 * different schema rules.
 */

export type IfcSchemaClassification =
    | "supported"
    | "unsupported_ifc4"
    | "unsupported_ifc2x3"
    | "unsupported_other"
    | "unknown";

/** The exact accepted IFC4x3 release identifiers (upper-cased) that IfcOpenShell can parse. */
export const SUPPORTED_IFC4X3_IDENTIFIERS: ReadonlySet<string> = new Set([
    "IFC4X3", "IFC4X3_ADD1", "IFC4X3_ADD2", "IFC4X3_TC1",
]);

/** Classify a declared header schema identifier against the precise IFC4x3 allowlist. */
export function classifyIfcSchema(schema: string | null | undefined): IfcSchemaClassification {
    if (typeof schema !== "string" || schema.trim().length === 0) return "unknown";
    const ident = schema.trim().toUpperCase();
    if (SUPPORTED_IFC4X3_IDENTIFIERS.has(ident)) return "supported";
    // An unrecognised IFC4X3_* variant (e.g. IFC4X3_RC1 / IFC4X3_FAKE / IFC4X3_ADD3) is
    // unsupported, NOT "IFC4" — classify it here, before the bare IFC4 branch.
    if (ident.startsWith("IFC4X3")) return "unsupported_other";
    if (ident.startsWith("IFC2X3")) return "unsupported_ifc2x3";
    if (ident.startsWith("IFC4")) return "unsupported_ifc4";
    return "unsupported_other";
}

/** True iff the declared schema belongs to the accepted IFC4x3 family. */
export function isSupportedIfc4x3Schema(schema: string | null | undefined): boolean {
    return classifyIfcSchema(schema) === "supported";
}

/** Structured, non-throwing gate result for the accepted IFC4x3 profile. */
export interface IfcSchemaGateResult {
    supported: boolean;
    classification: IfcSchemaClassification;
    schema: string | null;
    /** Stable machine code for a blocking outcome; null when supported. */
    code: "unsupported_ifc_schema" | null;
    message: string | null;
}

/**
 * Evaluate the IFC4x3 profile gate for a declared schema without throwing. The caller
 * decides whether to reject (the runtime enforcement point). Never interprets a Reference.
 */
export function evaluateIfcSchemaGate(schema: string | null | undefined): IfcSchemaGateResult {
    const classification = classifyIfcSchema(schema);
    const normalized = typeof schema === "string" ? schema.trim() : null;
    if (classification === "supported") {
        return { supported: true, classification, schema: normalized, code: null, message: null };
    }
    const detail = classification === "unsupported_ifc4"
        ? "IFC4 is not supported; only the IFC4x3 family is accepted"
        : classification === "unsupported_ifc2x3"
            ? "IFC2X3 is not supported; only the IFC4x3 family is accepted"
            : classification === "unknown"
                ? "the file declares no recognizable IFC schema; only the IFC4x3 family is accepted"
                : "the declared IFC schema is not supported; only the IFC4x3 family is accepted";
    return {
        supported: false,
        classification,
        schema: normalized,
        code: "unsupported_ifc_schema",
        message: `Unsupported IFC schema${normalized ? ` '${normalized}'` : ""}: ${detail}. The application profile requires IFC4x3 (ADR-0052).`,
    };
}

/**
 * Structured error for the single production IFC4x3 gate (ADR-0052 §A). Carries the same
 * shape the upload/intake failure contracts already consume: `statusCode` (HTTP 422),
 * `uploadStage` (folded into the recorded version failure reason), `failureReason`, plus
 * the stable machine `code` and the offending classification/schema for diagnostics.
 */
export class UnsupportedIfcSchemaError extends Error {
    readonly statusCode = 422 as const;
    readonly code = "unsupported_ifc_schema" as const;
    readonly uploadStage = "ifc_schema_gate" as const;
    readonly failureReason: string;
    readonly classification: IfcSchemaClassification;
    readonly schema: string | null;
    constructor(gate: IfcSchemaGateResult) {
        super(gate.message ?? "Unsupported IFC schema; the application profile requires IFC4x3.");
        this.name = "UnsupportedIfcSchemaError";
        this.failureReason = `unsupported IFC schema (${gate.schema ?? "none"}); IFC4x3 is required`;
        this.classification = gate.classification;
        this.schema = gate.schema;
    }
}

/**
 * The SINGLE production gate. Classifies the ACTUAL declared schema identifier (never a
 * caller-supplied `schemaSupported` flag) and throws `UnsupportedIfcSchemaError` when the
 * IFC4x3 profile is not satisfied. Both the controlled-intake preflight and the
 * initial/legacy upload path call this — no path re-implements the classification.
 */
export function assertSupportedIfc4x3Schema(schema: string | null | undefined): void {
    const gate = evaluateIfcSchemaGate(schema);
    if (!gate.supported) throw new UnsupportedIfcSchemaError(gate);
}
