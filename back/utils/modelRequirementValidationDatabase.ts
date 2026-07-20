import MySQLDatabase from "./mysqlDatabase.ts";
import type { ModelRequirementsValidationReport } from "../requirements/modelRequirementsValidationReport.ts";

export interface PersistValidationInput {
    report: ModelRequirementsValidationReport;
    modelVersionId: number | null;
    sourceKind: "upload" | "demo" | "cli" | "automated_test";
}

export interface ModelRequirementValidationDatabasePort {
    persist(input: PersistValidationInput): Promise<void>;
}

function value(value: string | null | undefined, max: number): string | null {
    return value === null || value === undefined ? null : String(value).slice(0, max);
}

export class ModelRequirementValidationDatabase implements ModelRequirementValidationDatabasePort {
    constructor(private readonly db = new MySQLDatabase()) {
        void this.db.connect();
    }

    async persist({ report, modelVersionId, sourceKind }: PersistValidationInput): Promise<void> {
        await this.db.withTransaction(async (conn) => {
            const [run]: any = await conn.execute(`
                INSERT INTO model_requirement_validation_runs
                    (run_uuid, model_version_id, source_kind, file_sha256, ifc_schema,
                     ids_profile_artifact_id, ids_profile_version, ids_profile_sha256,
                     validation_mode, overall_status, ids_status, project_rules_status,
                     executor_name, executor_version, started_at, completed_at)
                VALUES
                    (:runUuid, :modelVersionId, :sourceKind, :fileSha256, :ifcSchema,
                     :profileId, :profileVersion, :profileSha256, :mode, :overallStatus,
                     :idsStatus, :projectStatus, :executorName, :executorVersion,
                     :startedAt, :completedAt)
            `, {
                runUuid: report.runUuid,
                modelVersionId,
                sourceKind,
                fileSha256: report.fileSha256,
                ifcSchema: value(report.ifcSchema, 100),
                profileId: report.profile?.artifactId ?? null,
                profileVersion: value(report.profile?.version, 100),
                profileSha256: report.profile?.sha256 ?? null,
                mode: report.mode,
                overallStatus: report.overallStatus,
                idsStatus: report.idsStatus,
                projectStatus: report.projectRulesStatus,
                executorName: value(report.executor?.name, 200),
                executorVersion: value(report.executor?.version, 100),
                startedAt: report.startedAt.slice(0, 23).replace("T", " "),
                completedAt: report.completedAt.slice(0, 23).replace("T", " "),
            });
            const runId = Number(run.insertId);
            for (const finding of report.findings) {
                await conn.execute(`
                    INSERT INTO model_requirement_validation_results
                        (validation_run_id, source, requirement_id, requirement_name,
                         status, severity, entity_type, entity_guid, property_set,
                         property_name, expected_value, actual_value, message)
                    VALUES
                        (:runId, :source, :requirementId, :requirementName, :status,
                         :severity, :entityType, :entityGuid, :propertySet, :propertyName,
                         :expectedValue, :actualValue, :message)
                `, {
                    runId,
                    source: finding.source,
                    requirementId: value(finding.requirementId, 200),
                    requirementName: value(finding.requirementName, 500),
                    status: finding.status,
                    severity: finding.severity,
                    entityType: value(finding.entityType, 200),
                    entityGuid: value(finding.entityGuid, 64),
                    propertySet: value(finding.propertySet, 300),
                    propertyName: value(finding.propertyName, 300),
                    expectedValue: value(finding.expectedValue, 1000),
                    actualValue: value(finding.actualValue, 1000),
                    message: value(finding.message, 1000),
                });
            }
        });
    }
}
