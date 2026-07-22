import crypto from "node:crypto";
import MySQLDatabase from "./mysqlDatabase.ts";

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

    async findSpaceIdentity(linkedModelId: number, reference: string): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT id, space_uuid, inventory_code, name FROM spaces
            WHERE linked_model_id = :linkedModelId AND inventory_code_normalized = :reference LIMIT 1
        `, { linkedModelId, reference: reference.trim() });
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
                   sb.name_snapshot, sb.long_name_snapshot
            FROM space_bindings sb INNER JOIN spaces s ON s.id = sb.space_id
            WHERE sb.model_version_id = :versionId ORDER BY sb.id
        `, { versionId });
        const [assets]: any = await this.db.connection.execute(`
            SELECT a.id, a.asset_uuid, a.asset_code, a.serial_number, a.name,
                   ab.ifc_guid, ab.name_snapshot, ab.type_snapshot, ab.space_id,
                   s.space_uuid, s.inventory_code AS space_reference
            FROM asset_bindings ab INNER JOIN assets a ON a.id = ab.asset_id
            LEFT JOIN spaces s ON s.id = ab.space_id
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
