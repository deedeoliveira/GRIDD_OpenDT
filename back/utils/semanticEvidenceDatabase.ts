import MySQLDatabase from "./mysqlDatabase.ts";
import type { ResourceSemanticRow, SemanticEvidenceResponse } from "../semanticEvidence/semanticEvidenceTypes.ts";

function parsed(value: unknown): any {
    if (typeof value === "string") {
        try { return JSON.parse(value); } catch { return null; }
    }
    return value;
}

export interface SemanticEvidenceDatabasePort {
    resolveResource(assetId: number): Promise<ResourceSemanticRow | null>;
    persistCompleted(response: SemanticEvidenceResponse & { actorKeyNormalized: string; actorLinkId: number | null;
        institutionalArtifactId: number | null; policyArtifactId: number }): Promise<{ id: number }>;
    getRun(runUuid: string): Promise<{ id: number; row: any; response: SemanticEvidenceResponse } | null>;
    linkReservation(runId: number, reservationId: number, snapshotSha256: string): Promise<void>;
    tablesReady(): Promise<boolean>;
}

export class SemanticEvidenceDatabase implements SemanticEvidenceDatabasePort {
    constructor(private readonly db = new MySQLDatabase()) { void this.db.connect(); }

    async resolveResource(assetId: number): Promise<ResourceSemanticRow | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT a.id AS asset_id, a.asset_uuid, a.asset_code AS tag, s.inventory_code AS location,
                   ab.model_version_id, mv.version_uuid, msm.id AS materialisation_id,
                   msm.materialisation_uuid, msm.named_graph_uri, ab.ifc_guid,
                   svr.id AS structural_validation_run_id, svr.run_uuid AS structural_validation_run_uuid,
                   svr.conforms AS structural_conforms, svr.shapes_artifact_id,
                   shapes.semantic_version AS shapes_version
            FROM assets a
            LEFT JOIN asset_bindings ab ON ab.asset_id=a.id
            LEFT JOIN model_versions mv ON mv.id=ab.model_version_id
            LEFT JOIN models m ON m.id=mv.model_id AND m.current_version_id=mv.id
            LEFT JOIN spaces s ON s.id=ab.space_id
            LEFT JOIN model_version_semantic_materialisations msm
                   ON msm.model_version_id=mv.id AND msm.status='completed'
            LEFT JOIN semantic_validation_runs svr
                   ON svr.id=(SELECT svr2.id FROM semantic_validation_runs svr2
                              WHERE svr2.model_version_id=mv.id AND svr2.materialisation_id=msm.id
                                AND svr2.validation_kind='model_rdf_structural' AND svr2.status='completed'
                              ORDER BY svr2.completed_at DESC, svr2.id DESC LIMIT 1)
            LEFT JOIN semantic_artifacts shapes ON shapes.id=svr.shapes_artifact_id
            WHERE a.id=:assetId AND (ab.id IS NULL OR m.current_version_id IS NOT NULL)
            ORDER BY (m.current_version_id IS NOT NULL) DESC, ab.id DESC LIMIT 1
        `, { assetId });
        return rows[0] ?? null;
    }

    async persistCompleted(input: SemanticEvidenceResponse & { actorKeyNormalized: string; actorLinkId: number | null;
        institutionalArtifactId: number | null; policyArtifactId: number }): Promise<{ id: number }> {
        return this.db.withTransaction(async (connection) => {
            const [result]: any = await connection.execute(`INSERT INTO semantic_evidence_runs
                (run_uuid, actor_key_normalized, asset_id, asset_uuid, requested_start, requested_end,
                 actor_link_id, institutional_artifact_id, model_version_id, materialisation_id,
                 structural_validation_run_id, policy_artifact_id, evidence_graph_uri, policy_report_graph_uri,
                 evidence_graph_sha256, policy_report_sha256, actor_evidence_status, resource_evidence_status,
                 structural_status, shadow_eligibility_outcome, sql_availability_status, status, response_json,
                 created_at, completed_at, expires_at)
                VALUES (:runUuid,:actorKeyNormalized,:assetId,:assetUuid,:start,:end,
                        :actorLinkId,:institutionalArtifactId,:modelVersionId,:materialisationId,
                        :structuralValidationRunId,:policyArtifactId,:evidenceGraphUri,:policyReportGraphUri,
                        :evidenceGraphSha256,:policyReportSha256,:actorStatus,:resourceStatus,
                        :structuralStatus,:shadowOutcome,:availabilityStatus,'completed',:responseJson,
                        :createdAt,:createdAt,:expiresAt)`, {
                runUuid: input.runUuid, actorKeyNormalized: input.actorKeyNormalized, assetId: input.inputs.assetId,
                assetUuid: input.inputs.assetUuid, start: new Date(input.inputs.start), end: new Date(input.inputs.end),
                actorLinkId: input.actorLinkId, institutionalArtifactId: input.institutionalArtifactId,
                modelVersionId: input.resourceEvidence.modelVersionId, materialisationId: input.resourceEvidence.materialisationId,
                structuralValidationRunId: input.structuralEvidence.validationRunId, policyArtifactId: input.policyArtifactId,
                evidenceGraphUri: input.evidenceGraph.uri, policyReportGraphUri: input.policyReportGraph.uri,
                evidenceGraphSha256: input.evidenceGraph.sha256, policyReportSha256: input.policyReportGraph.sha256,
                actorStatus: input.actorEvidence.status, resourceStatus: input.resourceEvidence.status,
                structuralStatus: input.structuralEvidence.status, shadowOutcome: input.semanticEligibility.outcome,
                availabilityStatus: input.availability.status, responseJson: JSON.stringify(input),
                createdAt: new Date(input.createdAt), expiresAt: new Date(input.expiresAt),
            });
            const id = Number(result.insertId);
            for (const finding of input.semanticEligibility.findings) {
                await connection.execute(`INSERT INTO semantic_evidence_findings
                    (evidence_run_id,focus_node,result_path,result_value,source_shape,constraint_component,severity,message)
                    VALUES (:id,:focusNode,:resultPath,:value,:sourceShape,:sourceConstraintComponent,:severity,:message)`,
                { id, ...finding });
            }
            return { id };
        });
    }

    async getRun(runUuid: string): Promise<{ id: number; row: any; response: SemanticEvidenceResponse } | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute("SELECT * FROM semantic_evidence_runs WHERE run_uuid=:runUuid LIMIT 1", { runUuid });
        if (!rows.length) return null;
        return { id: Number(rows[0].id), row: rows[0], response: parsed(rows[0].response_json) };
    }

    async linkReservation(runId: number, reservationId: number, snapshotSha256: string): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`INSERT INTO reservation_semantic_evidence_links
            (reservation_id,evidence_run_id,snapshot_sha256) VALUES (:reservationId,:runId,:snapshotSha256)`,
        { reservationId, runId, snapshotSha256 });
    }

    async tablesReady(): Promise<boolean> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`SELECT COUNT(*) AS count FROM information_schema.TABLES
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('semantic_evidence_runs','semantic_evidence_findings','reservation_semantic_evidence_links')`);
        return Number(rows[0].count) === 3;
    }
}
