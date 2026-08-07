import crypto from "node:crypto";
import MySQLDatabase from "./mysqlDatabase.ts";
import { inspectCanonicalSpaceSchema, firstNonExactArtifact, findScopeCanonicalInconsistencies } from "./spaceCanonicalSchema.ts";

/**
 * Controlled Stage 0A precondition result for the model-intake preview (ADR-0051
 * Stage 0B §3). Carries a stable machine code and a concise operational message —
 * never SQL, driver text or a stack trace.
 */
export type PreviewCanonicalPreconditionCode = "ok" | "canonical_schema_missing" | "canonical_inconsistency";
export interface PreviewCanonicalPrecondition {
    code: PreviewCanonicalPreconditionCode;
    message: string | null;
}

export interface MaterialisationCreateInput {
    materialisationUuid: string;
    modelVersionId: number;
    mappingArtifactId: number;
    idsProfileArtifactId: number | null;
    namedGraphUri: string;
    sourceFileSha256: string;
    mappingVersion: string;
}

export class ModelIntakeDatabase {
    constructor(private readonly db = new MySQLDatabase()) { void this.db.connect(); }

    async listModelContexts(): Promise<any[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT m.id AS model_id, m.model_uuid, m.name AS model_name,
                   lm.id AS linked_model_id, lm.name AS linked_model_name,
                   v.id AS current_version_id, v.version_uuid AS current_version_uuid,
                   v.version_number AS current_version_number, v.file_hash AS current_ifc_hash,
                   COALESCE(history.version_count, 0) AS version_count,
                   latest.id AS latest_version_id, latest.status AS latest_version_status,
                   latest.created_at AS latest_version_created_at, latest.failure_reason AS latest_version_failure_reason
            FROM models m
            INNER JOIN linked_models lm ON lm.id = m.linked_parent_id
            LEFT JOIN model_versions v ON v.id = m.current_version_id
            LEFT JOIN (
                SELECT model_id, COUNT(*) AS version_count
                FROM model_versions GROUP BY model_id
            ) history ON history.model_id = m.id
            LEFT JOIN model_versions latest ON latest.id = (
                SELECT candidate.id FROM model_versions candidate
                WHERE candidate.model_id = m.id
                ORDER BY candidate.version_number DESC, candidate.id DESC LIMIT 1
            )
            ORDER BY lm.name, m.name, m.id
        `);
        return rows;
    }

    async getModelContext(modelId: number): Promise<any | null> {
        const rows = await this.listModelContexts();
        return rows.find((row) => Number(row.model_id) === modelId) ?? null;
    }

    /**
     * Stage 0A precondition for the preview (§3): verify the selected database and
     * the EXACT canonical schema, then the per-scope canonical integrity. Returns a
     * controlled code — never a raw SQL/driver error. Uses the SAME shared
     * inspection as the write path so preview and persistence cannot diverge.
     */
    async checkCanonicalPreconditionForScope(linkedModelId: number): Promise<PreviewCanonicalPrecondition> {
        try {
            // checkConnection is INSIDE the controlled try (§2-v3): a connection-setup
            // failure returns a stable operational code, never a raw driver error.
            await this.db.checkConnection();
            const [dbRows]: any = await this.db.connection.execute("SELECT DATABASE() AS db", {});
            const selected = dbRows?.[0]?.db;
            if (typeof selected !== "string" || selected.length === 0) {
                return { code: "canonical_schema_missing", message: "No database is selected; the canonical IfcSpace identity schema cannot be verified." };
            }
            const bad = firstNonExactArtifact(await inspectCanonicalSpaceSchema(this.db.connection));
            if (bad) {
                return { code: "canonical_schema_missing", message: `The Stage 0A canonical identity schema is not exactly present (${bad.artifact}: ${bad.state}).` };
            }
            const inc = await findScopeCanonicalInconsistencies(this.db.connection, linkedModelId);
            if (inc.nullCanonical.length > 0 || inc.bindingMismatch.length > 0) {
                return { code: "canonical_inconsistency", message: "Existing spaces or bindings are inconsistent with the canonical GlobalId; refusing to preview without repair." };
            }
            return { code: "ok", message: null };
        } catch {
            // Never surface a raw driver/SQL error to the BIM Manager.
            return { code: "canonical_schema_missing", message: "The canonical IfcSpace identity schema could not be verified." };
        }
    }

    /**
     * Stage 0B canonical preview lookup (ADR-0051): identity is
     * linked_model_id + exact case-sensitive IfcSpace.GlobalId. BINARY on both
     * sides makes the comparison byte-exact regardless of literal collation.
     */
    async findSpaceByGlobalId(linkedModelId: number, ifcGlobalId: string): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT id, space_uuid, ifc_global_id, inventory_code, inventory_code_normalized, long_name FROM spaces
            WHERE linked_model_id = :linkedModelId AND BINARY ifc_global_id = BINARY :ifcGlobalId LIMIT 1
        `, { linkedModelId, ifcGlobalId });
        return rows[0] ?? null;
    }

    /**
     * Inventory-code lookup used ONLY to surface an institutional inventory-code
     * collision (uq_spaces_scope_code) in the preview — never an identity key. The
     * inventory code comes from IfcSpace.Name (ADR-0052 §C).
     */
    async findSpaceByInventoryCode(linkedModelId: number, inventoryCode: string): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT id, space_uuid, ifc_global_id, inventory_code, inventory_code_normalized, long_name FROM spaces
            WHERE linked_model_id = :linkedModelId AND inventory_code_normalized = :inventoryCode LIMIT 1
        `, { linkedModelId, inventoryCode: inventoryCode.trim() });
        return rows[0] ?? null;
    }

    async findAssetIdentity(linkedModelId: number, tag: string): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT id, asset_uuid, asset_code, serial_number, name FROM assets
            WHERE linked_model_id = :linkedModelId AND asset_type = 'equipment' AND asset_code = :tag LIMIT 1
        `, { linkedModelId, tag: tag.trim().toUpperCase() });
        return rows[0] ?? null;
    }

    async getVersionSnapshot(versionId: number): Promise<{ version: any; spaces: any[]; assets: any[] } | null> {
        await this.db.checkConnection();
        const [versions]: any = await this.db.connection.execute(`
            SELECT v.id, v.version_uuid, v.version_number, v.model_id, v.original_filename,
                   v.file_hash, v.file_size, v.storage_key, v.status, v.created_at, m.model_uuid,
                   m.name AS model_name, m.linked_parent_id
            FROM model_versions v INNER JOIN models m ON m.id = v.model_id
            WHERE v.id = :versionId LIMIT 1
        `, { versionId });
        if (!versions.length) return null;
        const [spaces]: any = await this.db.connection.execute(`
            SELECT s.id, s.space_uuid, s.inventory_code, sb.ifc_guid,
                   sb.inventory_code_snapshot, sb.long_name_snapshot
            FROM space_bindings sb INNER JOIN spaces s ON s.id = sb.space_id
            WHERE sb.model_version_id = :versionId ORDER BY sb.id
        `, { versionId });
        // Modelled equipment location authority is ab.space_id (ADR-0052 §F). Expose the
        // bound space's PERSISTENT uuid (the relationship key) and the version-accurate
        // inventory-code SNAPSHOT for that same version (display only) — NEVER the mutable
        // current spaces.inventory_code, which would rewrite historical version semantics.
        const [assets]: any = await this.db.connection.execute(`
            SELECT a.id, a.asset_uuid, a.asset_code, a.serial_number, a.name,
                   ab.ifc_guid, ab.name_snapshot, ab.type_snapshot, ab.space_id,
                   s.space_uuid,
                   sbs.inventory_code_snapshot AS space_inventory_code_snapshot
            FROM asset_bindings ab INNER JOIN assets a ON a.id = ab.asset_id
            LEFT JOIN spaces s ON s.id = ab.space_id
            LEFT JOIN space_bindings sbs
                ON sbs.model_version_id = ab.model_version_id AND sbs.space_id = ab.space_id
            WHERE ab.model_version_id = :versionId AND a.asset_type = 'equipment'
            ORDER BY ab.id
        `, { versionId });
        return { version: versions[0], spaces, assets };
    }

    async ensureModelUuid(modelId: number): Promise<string> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute("SELECT model_uuid FROM models WHERE id = :modelId LIMIT 1", { modelId });
        if (!rows.length) throw new Error(`Model ${modelId} does not exist.`);
        if (rows[0].model_uuid) return rows[0].model_uuid;
        const candidate = crypto.randomUUID();
        await this.db.connection.execute("UPDATE models SET model_uuid = :candidate WHERE id = :modelId AND model_uuid IS NULL", { candidate, modelId });
        const [again]: any = await this.db.connection.execute("SELECT model_uuid FROM models WHERE id = :modelId", { modelId });
        return again[0].model_uuid;
    }

    async createMaterialisation(input: MaterialisationCreateInput): Promise<any> {
        await this.db.checkConnection();
        await this.db.connection.execute(`
            INSERT INTO model_version_semantic_materialisations
                (materialisation_uuid, model_version_id, mapping_artifact_id, ids_profile_artifact_id,
                 named_graph_uri, source_file_sha256, mapping_version, status, started_at)
            VALUES (:materialisationUuid, :modelVersionId, :mappingArtifactId, :idsProfileArtifactId,
                    :namedGraphUri, :sourceFileSha256, :mappingVersion, 'materialising', NOW(3))
            ON DUPLICATE KEY UPDATE materialisation_uuid = materialisation_uuid
        `, input as any);
        return this.getMaterialisationByVersion(input.modelVersionId);
    }

    async getMaterialisationByVersion(versionId: number): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT msm.*, sa.artifact_uuid AS mapping_artifact_uuid,
                   ids.artifact_uuid AS ids_profile_artifact_uuid
            FROM model_version_semantic_materialisations msm
            INNER JOIN semantic_artifacts sa ON sa.id = msm.mapping_artifact_id
            LEFT JOIN semantic_artifacts ids ON ids.id = msm.ids_profile_artifact_id
            WHERE msm.model_version_id = :versionId LIMIT 1
        `, { versionId });
        return rows[0] ?? null;
    }

    async markGraphWritten(id: number, counts: { tripleCount: number; spaceCount: number; assetCount: number; manifestationCount: number; turtleSha256: string }): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`
            UPDATE model_version_semantic_materialisations
            SET status='graph_written', triple_count=:tripleCount, space_count=:spaceCount,
                asset_count=:assetCount, manifestation_count=:manifestationCount,
                turtle_sha256=:turtleSha256, graph_written_at=NOW(3)
            WHERE id=:id
        `, { id, ...counts });
    }

    async markVerified(id: number): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`UPDATE model_version_semantic_materialisations
            SET status='completed', verified_at=NOW(3), completed_at=NOW(3), error_code=NULL, error_message=NULL WHERE id=:id`, { id });
    }

    async markFailed(id: number, code: string, message: string, retryable: boolean): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`UPDATE model_version_semantic_materialisations
            SET status=:status, error_code=:code, error_message=:message WHERE id=:id`, {
            id, code: code.slice(0, 100), message: message.slice(0, 1000), status: retryable ? "failed_retryable" : "failed_terminal",
        });
    }
}
