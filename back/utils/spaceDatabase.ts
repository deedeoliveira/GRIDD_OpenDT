import crypto from "crypto";
import MySQLDatabase from "./mysqlDatabase.ts";
import { isValidIfcGlobalId } from "./ifcGlobalId.ts";
import { inspectCanonicalSpaceSchema, firstNonExactArtifact, findScopeCanonicalInconsistencies } from "./spaceCanonicalSchema.ts";

/**
 * Raised when the Stage 0A canonical-identity schema foundation is absent or a
 * scope contains an existing canonical inconsistency. Stage 0B must fail with a
 * precise operational/configuration error and NEVER silently fall back to
 * Reference-based identity (ADR-0051 §4).
 */
export class SpaceCanonicalSchemaError extends Error {
    readonly code: "canonical_schema_missing" | "canonical_inconsistency";
    readonly diagnostics: any;
    constructor(code: "canonical_schema_missing" | "canonical_inconsistency", message: string, diagnostics: any = null) {
        super(message);
        this.name = "SpaceCanonicalSchemaError";
        this.code = code;
        this.diagnostics = diagnostics;
    }
}

/**
 * Cache of the structural Stage 0A capability, keyed by the ACTUAL selected
 * database (ADR-0051 §3). The canonical column + unique index are structural and
 * do not change per request, so a verified capability is remembered — but ONLY
 * for the exact schema it was verified against: a success for database A must
 * never authorize database B (multi-schema / test-reset safety). Only SUCCESSES
 * are cached; failures are never cached, so recovery after an intentional
 * migration or a process/test reset is possible. This structural cache never
 * hides a per-scope canonical inconsistency — that is checked separately, per
 * operation, in findScopeCanonicalInconsistencies().
 */
const canonicalSchemaVerifiedByDatabase = new Set<string>();
/** Test-only: forget every cached schema-capability result. */
export function resetCanonicalSchemaCache(): void { canonicalSchemaVerifiedByDatabase.clear(); }

/**
 * Timeout for the linked_model space-metadata lock (ADR-0052 §8, was ADR-0051 §6).
 * Exceeding it raises a ConcurrencyError('lock_timeout') without automatic retry — the
 * upload then fails cleanly (the previous version stays current) rather than proceeding
 * unprotected. The lock protects the mutable current space-metadata projection
 * (inventory_code, inventory_code_normalized, long_name), NOT a Reference.
 */
const SPACE_METADATA_LOCK_TIMEOUT_SECONDS = 30;

/**
 * Build the linked_model space-metadata advisory-lock name (ADR-0052 §8). MySQL
 * `GET_LOCK` names are SERVER-WIDE, so the name MUST include an exact, database-specific
 * component — otherwise two independent schemas that happen to contain the same numeric
 * `linked_model_id` (e.g. the disposable self-test and `digital_twin`) would contend. A
 * short stable hash of the EXACT selected database (`SELECT DATABASE()`, not merely
 * DB_NAME) is used; the final name stays well within MySQL's 64-character limit
 * (`oswadt:space_meta:` 18 + 16 hex + `:lm:` 4 + up to ~10 digits ≈ 48).
 */
export function spaceMetadataLockName(selectedDatabase: string, linkedModelId: number): string {
    const dbHash = crypto.createHash("sha256").update(selectedDatabase).digest("hex").slice(0, 16);
    return `oswadt:space_meta:${dbHash}:lm:${linkedModelId}`;
}

/**
 * Build the lock-name FACTORY used by {@link SpaceDatabase.withSpaceMetadataLock}
 * (ADR-0052 §8). The returned factory runs `SELECT DATABASE()` ON the dedicated
 * connection that withNamedLock will use to hold GET_LOCK, rejects a null/empty selected
 * database, and derives the database-scoped name from that ACTUAL selected schema — so
 * the schema that scopes the lock and the session that holds it are guaranteed to be the
 * same connection. Exported so the disposable-MySQL self-test can drive the REAL helper
 * against two genuinely different selected schemas, not two arbitrary name strings.
 */
export function spaceMetadataLockNameFactory(linkedModelId: number): (conn: any) => Promise<string> {
    return async (conn: any) => {
        const [rows]: any = await conn.query("SELECT DATABASE() AS db");
        const selectedDatabase = rows?.[0]?.db;
        if (typeof selectedDatabase !== "string" || selectedDatabase.length === 0) {
            throw new SpaceCanonicalSchemaError(
                "canonical_schema_missing",
                "No database is selected on the current connection; the linked_model space-metadata lock cannot be scoped safely.",
                { selectedDatabase: selectedDatabase ?? null },
            );
        }
        return spaceMetadataLockName(selectedDatabase, linkedModelId);
    };
}

/**
 * Persistência da identidade dos espaços (spaces + space_bindings) — Prompt 3.
 *
 * Regras estruturais:
 *  - unicidade provisória por âmbito: UNIQUE(linked_model_id,
 *    inventory_code_normalized) — ADR-0005;
 *  - uma entity nunca liga a dois espaços (UNIQUE(entity_id));
 *  - um espaço tem no máximo um binding por versão (UNIQUE(space_id,
 *    model_version_id));
 *  - bindings históricos nunca são sobrescritos;
 *  - a versão é sempre explícita (nunca "o maior id").
 */
class SpaceDatabase {
    private db: MySQLDatabase;

    constructor() {
        this.db = new MySQLDatabase();
        this.db.connect();
    }

    /**
     * Cooperative, cross-process advisory lock scoped to ONE linked_model (ADR-0051
     * §6). Held from before any administrative-Reference mutation through activation
     * AND Reference compensation, so the previous Reference of a reused space cannot
     * be claimed by another cooperating operation on the SAME linked_model during
     * that window. Different linked_models use distinct lock names and never block
     * each other. Uses MySQL GET_LOCK on a dedicated pool connection (session-scoped
     * server-side), so it serialises within AND across backend processes — never a
     * process-local mutex (§6.10). Released in finally by withNamedLock (§6.9).
     */
    async withSpaceMetadataLock<T>(linkedModelId: number, fn: () => Promise<T>): Promise<T> {
        await this.db.checkConnection();
        // Scope the lock to the ACTUAL selected database (SELECT DATABASE(), not merely
        // DB_NAME) AND derive that name ON the very connection that will hold GET_LOCK,
        // via a name factory. This guarantees the schema that scopes the lock and the
        // dedicated session that holds it are the SAME connection — never a different pool
        // connection whose selected database could differ.
        return this.db.withNamedLock(spaceMetadataLockNameFactory(linkedModelId), SPACE_METADATA_LOCK_TIMEOUT_SECONDS, fn);
    }

    /**
     * Identity authority is linked_model_id + IfcSpace.GlobalId (ADR-0052 §B). This
     * inventory-code lookup is used ONLY to detect an institutional inventory-code
     * collision against the scope uniqueness constraint uq_spaces_scope_code (the
     * inventory code now comes from IfcSpace.Name). It is NEVER the identity key and
     * never a Reference lookup.
     */
    async findByScopeAndCode(linkedModelId: number, normalizedCode: string): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT * FROM spaces
            WHERE linked_model_id = :linkedModelId
              AND inventory_code_normalized = :normalizedCode
            LIMIT 1
        `, { linkedModelId, normalizedCode });
        return rows[0] ?? null;
    }

    /**
     * Canonical identity lookup (Stage 0B): linked_model_id + exact case-sensitive
     * IfcSpace.GlobalId. Uses BINARY on both sides so the comparison is byte-exact
     * regardless of literal collation and mirrors the ascii_bin column semantics.
     */
    async findByScopeAndGlobalId(linkedModelId: number, ifcGlobalId: string): Promise<any | null> {
        if (!isValidIfcGlobalId(ifcGlobalId)) {
            throw new Error("findByScopeAndGlobalId requires a valid IFC GlobalId (^[0-9A-Za-z_$]{22}$).");
        }
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT * FROM spaces
            WHERE linked_model_id = :linkedModelId
              AND BINARY ifc_global_id = BINARY :ifcGlobalId
            LIMIT 1
        `, { linkedModelId, ifcGlobalId });
        return rows[0] ?? null;
    }

    async createSpace(input: {
        linkedModelId: number;
        ifcGlobalId: string;
        inventoryCode: string;
        inventoryCodeNormalized: string;
        longName?: string | null;
    }): Promise<{ spaceId: number; spaceUuid: string }> {
        if (!isValidIfcGlobalId(input.ifcGlobalId)) {
            throw new Error("createSpace requires a valid IFC GlobalId (^[0-9A-Za-z_$]{22}$).");
        }
        await this.db.checkConnection();

        const spaceUuid = crypto.randomUUID();

        // Every newly created spaces row receives its canonical ifc_global_id (ADR-0052
        // §B). inventory_code/_normalized come from IfcSpace.Name; long_name from
        // IfcSpace.LongName (nullable).
        const [result]: any = await this.db.connection.execute(`
            INSERT INTO spaces
                (space_uuid, ifc_global_id, inventory_code, inventory_code_normalized, linked_model_id, long_name, status)
            VALUES
                (:spaceUuid, :ifcGlobalId, :inventoryCode, :inventoryCodeNormalized, :linkedModelId, :longName, 'active')
        `, {
            spaceUuid,
            ifcGlobalId: input.ifcGlobalId,
            inventoryCode: input.inventoryCode,
            inventoryCodeNormalized: input.inventoryCodeNormalized,
            linkedModelId: input.linkedModelId,
            longName: input.longName ?? null,
        });

        return { spaceId: result.insertId, spaceUuid };
    }

    /**
     * Update ONLY the current mutable space-metadata projection of a persistent space
     * whose identity (linked_model + GlobalId) is unchanged (ADR-0052 §8): the
     * institutional inventory_code (from IfcSpace.Name), its normalized form, and the
     * long_name (from IfcSpace.LongName). Historical binding snapshots are never touched;
     * ifc_global_id, space_uuid and spaces.id are never modified here.
     */
    async updateCurrentSpaceMetadata(input: {
        spaceId: number;
        inventoryCode: string;
        inventoryCodeNormalized: string;
        longName?: string | null;
    }): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`
            UPDATE spaces
               SET inventory_code = :inventoryCode,
                   inventory_code_normalized = :inventoryCodeNormalized,
                   long_name = :longName
             WHERE id = :spaceId
        `, {
            spaceId: input.spaceId,
            inventoryCode: input.inventoryCode,
            inventoryCodeNormalized: input.inventoryCodeNormalized,
            longName: input.longName ?? null,
        });
    }

    /**
     * Compensating restore of a REUSED space's mutable metadata projection (ADR-0052 §8).
     * A FULL compare-and-swap: the restore reverts a row ONLY when its current projection
     * still matches the COMPLETE projection this operation applied — `inventory_code`
     * (from IfcSpace.Name), `inventory_code_normalized` AND `long_name` (from
     * IfcSpace.LongName). The comparison is BYTE-EXACT (explicit `BINARY`), independent of
     * the table's case-insensitive collation, and NULL-safe for `long_name`
     * (`BINARY long_name <=> BINARY :appliedLongName`). So a newer change to the inventory
     * code or the long name — even a CASE-only or ACCENT-only change the default collation
     * would treat as equal — is never clobbered. spaces.id / space_uuid / ifc_global_id
     * are never touched. Returns the number of rows restored (0 = a newer projection won
     * or the row is gone; left as-is).
     */
    async restoreSpaceMetadata(input: {
        spaceId: number;
        appliedInventoryCode: string;
        appliedInventoryCodeNormalized: string;
        appliedLongName: string | null;
        previousInventoryCode: string | null;
        previousInventoryCodeNormalized: string | null;
        previousLongName: string | null;
    }): Promise<number> {
        await this.db.checkConnection();
        const [result]: any = await this.db.connection.execute(`
            UPDATE spaces
               SET inventory_code = :previousInventoryCode,
                   inventory_code_normalized = :previousInventoryCodeNormalized,
                   long_name = :previousLongName
             WHERE id = :spaceId
               AND BINARY inventory_code = BINARY :appliedInventoryCode
               AND BINARY inventory_code_normalized = BINARY :appliedInventoryCodeNormalized
               AND BINARY long_name <=> BINARY :appliedLongName
        `, {
            spaceId: input.spaceId,
            previousInventoryCode: input.previousInventoryCode,
            previousInventoryCodeNormalized: input.previousInventoryCodeNormalized,
            previousLongName: input.previousLongName,
            appliedInventoryCode: input.appliedInventoryCode,
            appliedInventoryCodeNormalized: input.appliedInventoryCodeNormalized,
            appliedLongName: input.appliedLongName,
        });
        return Number(result.affectedRows ?? 0);
    }

    async createBinding(input: {
        spaceId: number;
        modelVersionId: number;
        entityId: number;
        ifcGuid: string;
        inventoryCodeSnapshot: string;
        longNameSnapshot?: string | null;
    }): Promise<number> {
        if (!isValidIfcGlobalId(input.ifcGuid)) {
            throw new Error("createBinding requires a valid IFC GlobalId (^[0-9A-Za-z_$]{22}$) for ifc_guid.");
        }
        await this.db.checkConnection();

        // Atomic binding/canonical + chain equality (ADR-0051 §10, Stage 0B §4/§5):
        // the binding is written by INSERT ... SELECT joining spaces → model_versions →
        // models, so `ifc_guid` is taken from the canonical `spaces.ifc_global_id`
        // itself and the row is inserted ONLY when, ATOMICALLY:
        //  - the space exists (s.id = :spaceId);
        //  - the supplied GlobalId byte-matches the canonical value (BINARY equality);
        //  - the model version exists (mv.id = :modelVersionId) and its model exists;
        //  - the space and the version's model belong to the SAME linked_model
        //    (m.linked_parent_id = s.linked_model_id).
        // Any violation yields zero inserted rows — never a binding that disagrees with
        // its space or crosses linked_models, never an insert-then-repair. Existing
        // uq_binding_entity / uq_binding_space_version duplicate-key handling is
        // preserved (the driver still raises ER_DUP_ENTRY for those).
        const [result]: any = await this.db.connection.execute(`
            INSERT INTO space_bindings
                (space_id, model_version_id, entity_id, ifc_guid,
                 inventory_code_snapshot, long_name_snapshot, binding_status)
            SELECT s.id, mv.id, :entityId, s.ifc_global_id,
                   :inventoryCodeSnapshot, :longNameSnapshot, 'active'
              FROM spaces s
              JOIN model_versions mv ON mv.id = :modelVersionId
              JOIN models m ON m.id = mv.model_id
             WHERE s.id = :spaceId
               AND m.linked_parent_id = s.linked_model_id
               AND BINARY s.ifc_global_id = BINARY :ifcGuid
        `, {
            spaceId: input.spaceId,
            modelVersionId: input.modelVersionId,
            entityId: input.entityId,
            ifcGuid: input.ifcGuid,
            inventoryCodeSnapshot: input.inventoryCodeSnapshot,
            longNameSnapshot: input.longNameSnapshot ?? null,
        });

        if (Number(result.affectedRows) !== 1) {
            // Zero rows: classify WHY (where safely possible) with a single diagnostic
            // query — missing space vs canonical GlobalId mismatch vs missing model
            // version/model vs linked-model chain mismatch. Never repairs anything.
            const reason = await this.diagnoseBindingRejection(input.spaceId, input.modelVersionId, input.ifcGuid);
            throw new SpaceCanonicalSchemaError(
                "canonical_inconsistency",
                `Refusing to create a space binding for space ${input.spaceId} / model version ${input.modelVersionId}: ${reason.message}. No binding was written and none was repaired.`,
                { spaceId: input.spaceId, modelVersionId: input.modelVersionId, ifcGuid: input.ifcGuid,
                  affectedRows: Number(result.affectedRows ?? 0), cause: reason.cause },
            );
        }
        return result.insertId;
    }

    /**
     * Best-effort classification of a zero-row createBinding rejection (ADR-0051 §4).
     * A single query counts the independent preconditions so the operational error can
     * distinguish, where safely possible, the cause. Read-only; never repairs.
     */
    private async diagnoseBindingRejection(spaceId: number, modelVersionId: number, ifcGuid: string):
        Promise<{ cause: string; message: string }> {
        try {
            const [rows]: any = await this.db.connection.execute(`
                SELECT
                  (SELECT COUNT(*) FROM spaces s WHERE s.id = :spaceId) AS space_exists,
                  (SELECT COUNT(*) FROM spaces s WHERE s.id = :spaceId AND BINARY s.ifc_global_id = BINARY :ifcGuid) AS guid_matches,
                  (SELECT COUNT(*) FROM model_versions mv WHERE mv.id = :modelVersionId) AS version_exists,
                  (SELECT COUNT(*)
                     FROM spaces s
                     JOIN model_versions mv ON mv.id = :modelVersionId
                     JOIN models m ON m.id = mv.model_id
                    WHERE s.id = :spaceId AND m.linked_parent_id = s.linked_model_id) AS chain_matches
            `, { spaceId, modelVersionId, ifcGuid });
            const r = rows?.[0] ?? {};
            if (Number(r.space_exists) === 0) return { cause: "missing_space", message: `space ${spaceId} does not exist` };
            if (Number(r.guid_matches) === 0) return { cause: "canonical_globalid_mismatch", message: "the supplied GlobalId does not byte-match the canonical spaces.ifc_global_id" };
            if (Number(r.version_exists) === 0) return { cause: "missing_model_version", message: `model version ${modelVersionId} (or its model) does not exist` };
            if (Number(r.chain_matches) === 0) return { cause: "linked_model_chain_mismatch", message: "the space and the version's model belong to different linked_models" };
            return { cause: "unknown", message: "the atomic binding precondition was not satisfied" };
        } catch {
            return { cause: "undiagnosed", message: "the atomic binding precondition was not satisfied" };
        }
    }

    /**
     * Stage 0A schema precondition (ADR-0051 §4), cached per process. Verifies the
     * canonical column `spaces.ifc_global_id` (char/ascii_bin) and the unique index
     * `uq_spaces_linked_model_ifc_global_id` exist. Throws a precise operational
     * error otherwise — never recreates the schema, never runs a migration, never
     * falls back to Reference.
     */
    async assertCanonicalSpaceSchema(): Promise<void> {
        await this.db.checkConnection();

        // Determine the ACTUAL selected schema; the cache is keyed by it so a
        // verification for one database can never authorize another (§3.1/§3.4).
        const [dbRows]: any = await this.db.connection.execute("SELECT DATABASE() AS db", {});
        const selectedDatabase = dbRows?.[0]?.db;
        if (typeof selectedDatabase !== "string" || selectedDatabase.length === 0) {
            throw new SpaceCanonicalSchemaError(
                "canonical_schema_missing",
                "No database is selected on the current connection; the Stage 0A canonical IfcSpace identity schema cannot be verified. Runtime does not fall back to Reference.",
                { selectedDatabase: selectedDatabase ?? null },
            );
        }
        if (canonicalSchemaVerifiedByDatabase.has(selectedDatabase)) return;

        // EXACT structural verification (§4): column type/length/charset/collation/
        // nullability/default/generation, the enforced case-sensitive CHECK, and the
        // canonical AND legacy unique indexes (uniqueness, exact columns/order, no
        // prefix/expression, visible). Both ABSENT and CONFLICTING are blocking; only
        // an all-EXACT result is cached. A failure is NEVER cached, so recovery after
        // a migration/reset works. No SQL/driver text reaches the caller message.
        const inspection = await inspectCanonicalSpaceSchema(this.db.connection);
        const bad = firstNonExactArtifact(inspection);
        if (bad) {
            throw new SpaceCanonicalSchemaError(
                "canonical_schema_missing",
                `The Stage 0A canonical IfcSpace identity schema is not exactly present (${bad.artifact}: ${bad.state}). Apply/repair the Stage 0A migration before running GlobalId-based intake. Runtime does not fall back to Reference.`,
                { database: selectedDatabase, artifact: bad.artifact, state: bad.state, detail: bad.detail },
            );
        }
        canonicalSchemaVerifiedByDatabase.add(selectedDatabase);
    }

    /**
     * Scope-level canonical integrity (ADR-0051 §4): an existing spaces row with a
     * NULL canonical GlobalId, or a binding whose GlobalId disagrees byte-for-byte
     * with its space's canonical value, is a Stage 0A-incomplete inconsistency.
     * Returns the offending rows; the caller blocks and never repairs silently.
     */
    async findScopeCanonicalInconsistencies(linkedModelId: number): Promise<{ nullCanonical: number[]; bindingMismatch: any[] }> {
        await this.db.checkConnection();
        // Shared definition (§3.8) so persistence and preview never diverge.
        return findScopeCanonicalInconsistencies(this.db.connection, linkedModelId);
    }

    async hasBindingForEntity(entityId: number): Promise<boolean> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(
            "SELECT id FROM space_bindings WHERE entity_id = :entityId LIMIT 1", { entityId });
        return rows.length > 0;
    }

    /** Compensação de falha: remove os bindings da versão (antes de apagar entities). */
    async deleteBindingsForVersion(versionId: number): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(
            "DELETE FROM space_bindings WHERE model_version_id = :versionId", { versionId });
    }

    /**
     * Compensação de falha: remove APENAS espaços criados exclusivamente pela
     * operação falhada e sem nenhum outro binding. Espaços preexistentes nunca
     * são apagados.
     */
    async deleteSpacesWithoutBindings(spaceIds: number[]): Promise<void> {
        if (!spaceIds.length) return;
        await this.db.checkConnection();

        for (const spaceId of spaceIds) {
            await this.db.connection.execute(`
                DELETE FROM spaces
                WHERE id = :spaceId
                  AND NOT EXISTS (SELECT 1 FROM space_bindings sb WHERE sb.space_id = :spaceId2)
            `, { spaceId, spaceId2: spaceId });
        }
    }

    /**
     * Reconciliação de estado após ativação de uma versão do modelo espacial
     * AUTORITATIVO: espaços do âmbito cujo código não está na versão corrente
     * ficam 'absent'; os presentes voltam a 'active'. Nunca apaga nem retira
     * (retired é operação explícita futura); nunca toca em reservas/ativos.
     */
    async reconcileStatusesForLinkedModel(linkedModelId: number, presentNormalizedCodes: string[]): Promise<void> {
        await this.db.checkConnection();

        if (presentNormalizedCodes.length === 0) {
            await this.db.connection.execute(`
                UPDATE spaces SET status = 'absent'
                WHERE linked_model_id = :linkedModelId AND status = 'active'
            `, { linkedModelId });
            return;
        }

        const placeholders = presentNormalizedCodes.map((_, i) => `:code${i}`).join(", ");
        const params: any = { linkedModelId };
        presentNormalizedCodes.forEach((c, i) => { params[`code${i}`] = c; });

        await this.db.connection.execute(`
            UPDATE spaces SET status = 'absent'
            WHERE linked_model_id = :linkedModelId
              AND status = 'active'
              AND inventory_code_normalized NOT IN (${placeholders})
        `, params);

        await this.db.connection.execute(`
            UPDATE spaces SET status = 'active'
            WHERE linked_model_id = :linkedModelId
              AND status = 'absent'
              AND inventory_code_normalized IN (${placeholders})
        `, params);
    }

    async getSpacesByLinkedModel(linkedModelId: number): Promise<any[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT * FROM spaces
            WHERE linked_model_id = :linkedModelId
            ORDER BY inventory_code_normalized ASC
        `, { linkedModelId });
        return rows;
    }

    async getBindingsBySpace(spaceId: number): Promise<any[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT sb.*, v.version_number, v.status AS version_status, v.model_id
            FROM space_bindings sb
            INNER JOIN model_versions v ON v.id = sb.model_version_id
            WHERE sb.space_id = :spaceId
            ORDER BY sb.model_version_id ASC
        `, { spaceId });
        return rows;
    }

    async getBindingsByVersion(versionId: number): Promise<any[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT sb.*, s.space_uuid, s.inventory_code, s.status AS space_status
            FROM space_bindings sb
            INNER JOIN spaces s ON s.id = sb.space_id
            WHERE sb.model_version_id = :versionId
            ORDER BY sb.id ASC
        `, { versionId });
        return rows;
    }

    /**
     * Autoridade espacial da federação (ADR-0006): valor explícito de
     * linked_models.spatial_authority_model_id; por omissão, quando a federação
     * tem exatamente um model, esse model é a autoridade; com vários models e
     * sem configuração, NENHUMA autoridade é assumida (pendente de confirmação).
     */
    async resolveSpatialAuthority(linkedModelId: number): Promise<number | null> {
        await this.db.checkConnection();

        const [rows]: any = await this.db.connection.execute(`
            SELECT lm.spatial_authority_model_id, COUNT(m.id) AS model_count, MIN(m.id) AS single_model_id
            FROM linked_models lm
            LEFT JOIN models m ON m.linked_parent_id = lm.id
            WHERE lm.id = :linkedModelId
            GROUP BY lm.id, lm.spatial_authority_model_id
        `, { linkedModelId });

        if (!rows.length) return null;

        if (rows[0].spatial_authority_model_id) return rows[0].spatial_authority_model_id;
        if (Number(rows[0].model_count) === 1) return rows[0].single_model_id;

        return null;
    }
}

export default new SpaceDatabase();
