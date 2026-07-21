import MySQLDatabase from "./mysqlDatabase.ts";
import type { SemanticValidationReport } from "../semanticValidation/semanticValidationTypes.ts";

export class SemanticValidationDatabase {
    constructor(private readonly db = new MySQLDatabase()) { void this.db.connect(); }

    async persistCompleted(input: SemanticValidationReport & { dataGraphUri: string | null }): Promise<any> {
        return this.db.withTransaction(async (connection) => {
            await connection.execute(`
                INSERT INTO semantic_validation_runs
                    (run_uuid, validation_kind, model_version_id, materialisation_id, data_graph_sha256,
                     data_graph_uri, shapes_artifact_id, shapes_sha256, shapes_source, executor_name,
                     executor_version, inference_mode, advanced_enabled, meta_shacl_enabled, conforms,
                     result_count, status, started_at, completed_at, report_graph_uri, report_sha256)
                VALUES (:runUuid, :validationKind, :modelVersionId, :materialisationId, :dataGraphSha256,
                        :dataGraphUri, :shapesArtifactId, :shapesGraphSha256, :shapesSource, :executorName,
                        :executorVersion, :inferenceMode, :advanced, :metaShacl, :conforms,
                        :resultCount, 'completed', :startedAt, :completedAt, :reportGraphUri, :reportSha256)
                ON DUPLICATE KEY UPDATE run_uuid=run_uuid
            `, input as any);
            const [rows]: any = await connection.execute("SELECT id FROM semantic_validation_runs WHERE run_uuid=:runUuid LIMIT 1", { runUuid: input.runUuid });
            const id = Number(rows[0].id);
            const [existing]: any = await connection.execute("SELECT COUNT(*) AS count FROM semantic_validation_results WHERE validation_run_id=:id", { id });
            if (Number(existing[0].count) === 0) {
                for (const result of input.results) {
                    await connection.execute(`INSERT INTO semantic_validation_results
                        (validation_run_id, focus_node, result_path, result_value, source_shape, constraint_component, severity, message)
                        VALUES (:id, :focusNode, :resultPath, :value, :sourceShape, :sourceConstraintComponent, :severity, :message)`,
                    { id, ...result });
                }
            }
            return { id };
        });
    }

    async getRun(runUuid: string): Promise<any | null> {
        await this.db.checkConnection();
        const [runs]: any = await this.db.connection.execute(`SELECT r.*, a.artifact_uuid AS shapes_artifact_uuid,
            a.family_id AS shapes_family_id FROM semantic_validation_runs r
            LEFT JOIN semantic_artifacts a ON a.id=r.shapes_artifact_id WHERE r.run_uuid=:runUuid LIMIT 1`, { runUuid });
        if (!runs.length) return null;
        const [results]: any = await this.db.connection.execute(`SELECT focus_node AS focusNode, result_path AS resultPath,
            result_value AS value, source_shape AS sourceShape, constraint_component AS sourceConstraintComponent,
            severity, message FROM semantic_validation_results WHERE validation_run_id=:id ORDER BY id`, { id: runs[0].id });
        return { run: runs[0], results };
    }

    async tablesReady(): Promise<boolean> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`SELECT COUNT(*) AS count FROM information_schema.TABLES
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('semantic_validation_runs','semantic_validation_results')`);
        return Number(rows[0].count) === 2;
    }
}
