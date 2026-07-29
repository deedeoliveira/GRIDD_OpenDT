/**
 * Shared, single-source-of-truth inspection of the Stage 0A canonical-identity
 * schema (ADR-0051 §4, Stage 0B §3/§4). BOTH the write path
 * (`utils/spaceDatabase.ts`) and the model-intake preview
 * (`utils/modelIntakeDatabase.ts`) classify the schema through THIS module, so
 * persistence and preview can never diverge on what "the Stage 0A capability" means.
 *
 * The exact EXACT / CONFLICTING / ABSENT inspectors are reused verbatim from the
 * migration mechanism (`scripts/migrations/spaceGlobalId.ts`) — the same code that
 * created and verified the schema — rather than re-deriving weaker name/count
 * checks. They verify:
 *  - column: DATA_TYPE=char, length=22, charset=ascii, collation=ascii_bin,
 *    IS_NULLABLE=YES, no default, not generated;
 *  - `chk_spaces_ifc_global_id_format`: exactly one CHECK, the case-sensitive
 *    `^[0-9A-Za-z_$]{22}$` clause, ENFORCED=YES;
 *  - `uq_spaces_linked_model_ifc_global_id`: NON_UNIQUE=0, exactly
 *    (linked_model_id, ifc_global_id) in order, no prefix, no expression, visible;
 *  - `uq_spaces_scope_code` (still required transitionally): NON_UNIQUE=0, exactly
 *    (linked_model_id, inventory_code_normalized) in order, no prefix/expr, visible.
 *
 * Both ABSENT and CONFLICTING are blocking; only an all-EXACT result is a pass.
 */
import { inspectColumn, inspectIndex, inspectCheck, inspectLegacyScopeIndex, type Inspection } from "../scripts/migrations/spaceGlobalId.ts";

/** Minimal shape accepted for inspection — a mysql2 Pool facade or Connection. */
export interface Queryable { query(sql: string, params?: any): Promise<any>; }

export interface CanonicalSchemaInspection {
    column: Inspection;
    canonicalIndex: Inspection;
    check: Inspection;
    legacyIndex: Inspection;
}

/** Run all four exact inspectors against the connection's current default schema. */
export async function inspectCanonicalSpaceSchema(conn: Queryable): Promise<CanonicalSchemaInspection> {
    return {
        column: await inspectColumn(conn as any),
        canonicalIndex: await inspectIndex(conn as any),
        check: await inspectCheck(conn as any),
        legacyIndex: await inspectLegacyScopeIndex(conn as any),
    };
}

/**
 * The first artifact that is not EXACT (in a stable order), or null when every
 * artifact is EXACT. The `state` is ABSENT or CONFLICTING; both are blocking.
 * `detail` carries an actual-vs-expected metadata description (never SQL) for
 * operator diagnostics/logs — not for end-user messages.
 */
export function firstNonExactArtifact(i: CanonicalSchemaInspection):
    { artifact: string; state: "ABSENT" | "CONFLICTING"; detail: string } | null {
    const ordered: Array<[string, Inspection]> = [
        ["spaces.ifc_global_id column", i.column],
        ["uq_spaces_linked_model_ifc_global_id", i.canonicalIndex],
        ["chk_spaces_ifc_global_id_format", i.check],
        ["uq_spaces_scope_code (transitional)", i.legacyIndex],
    ];
    for (const [artifact, insp] of ordered) {
        if (insp.state !== "EXACT") return { artifact, state: insp.state, detail: insp.detail };
    }
    return null;
}

/**
 * Per-scope canonical integrity, shared by persistence and preview so both use the
 * SAME definition (§3.8): an existing spaces row with a NULL canonical GlobalId, or
 * a binding whose GlobalId disagrees byte-for-byte with its space's canonical value.
 * Positional `?` parameters so it runs on either pool (namedPlaceholders affects
 * only `:name`). The literal substrings `ifc_global_id IS NULL` and
 * `BINARY sb.ifc_guid <> BINARY s.ifc_global_id` are relied upon by fake-DB routing.
 */
export async function findScopeCanonicalInconsistencies(
    conn: Queryable, linkedModelId: number,
): Promise<{ nullCanonical: number[]; bindingMismatch: any[] }> {
    const [nulls]: any = await conn.query(
        "SELECT id FROM spaces WHERE linked_model_id = ? AND ifc_global_id IS NULL", [linkedModelId]);
    const [mismatch]: any = await conn.query(`
        SELECT sb.id AS binding_id, sb.space_id, sb.ifc_guid AS binding_guid, s.ifc_global_id AS canonical
          FROM space_bindings sb
          INNER JOIN spaces s ON s.id = sb.space_id
         WHERE s.linked_model_id = ?
           AND BINARY sb.ifc_guid <> BINARY s.ifc_global_id
    `, [linkedModelId]);
    return {
        nullCanonical: (nulls as any[]).map((r) => Number(r.id)),
        bindingMismatch: mismatch as any[],
    };
}
