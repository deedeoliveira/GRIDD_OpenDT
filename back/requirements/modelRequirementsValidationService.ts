import crypto from "node:crypto";
import fs from "node:fs";
import { loadIdsValidationConfig, type IdsValidationConfig } from "./idsValidationConfig.ts";
import { IfcOpenShellIdsValidationProvider } from "./ifcOpenShellIdsValidationProvider.ts";
import { IdsProfileResolver, type ActiveIdsProfileResolver } from "./idsProfileResolver.ts";
import type { IdsProfileMetadata, IdsValidationProvider, NormalizedRequirementFinding } from "./idsValidationTypes.ts";
import type { ExtractedIfcModel, ModelInformationRequirementsValidator, ModelRequirementsContext } from "./modelRequirementsTypes.ts";
import type { ModelRequirementsValidationReport } from "./modelRequirementsValidationReport.ts";
import { ModelRequirementValidationDatabase, type ModelRequirementValidationDatabasePort } from "../utils/modelRequirementValidationDatabase.ts";

export interface ComposedValidationInput {
    ifcPath: string;
    extractedModel: ExtractedIfcModel;
    context: ModelRequirementsContext;
    projectValidator?: ModelInformationRequirementsValidator;
    projectFindings?: NormalizedRequirementFinding[];
    sourceKind: "upload" | "demo" | "cli" | "automated_test";
    correlationId?: string;
    /** Perfil já verificado pelo executor (upload IDS temporário ou seleção governada explícita). */
    profileOverride?: IdsProfileMetadata;
}

function normalizeProject(findings: any[]): NormalizedRequirementFinding[] {
    return findings.map((finding) => ({
        source: "project_rule",
        requirementId: finding.requirementId,
        requirementName: finding.requirementId,
        status: finding.severity === "error" ? "fail" : "warning",
        severity: finding.severity,
        entityType: finding.ifcClass ?? null,
        entityGuid: finding.entityGuid ?? null,
        propertySet: (finding.details as any)?.propertySet ?? null,
        propertyName: (finding.details as any)?.propertyName ?? null,
        expectedValue: null,
        actualValue: null,
        message: finding.message,
    }));
}

export class ModelRequirementsValidationService {
    constructor(
        private readonly config: IdsValidationConfig = loadIdsValidationConfig(),
        private readonly provider: IdsValidationProvider = new IfcOpenShellIdsValidationProvider(),
        private readonly profiles: ActiveIdsProfileResolver = new IdsProfileResolver(),
        private readonly reports: ModelRequirementValidationDatabasePort = new ModelRequirementValidationDatabase(),
        private readonly now: () => Date = () => new Date(),
        private readonly newUuid: () => string = () => crypto.randomUUID()
    ) {}

    async validate(input: ComposedValidationInput): Promise<ModelRequirementsValidationReport> {
        const started = this.now();
        const runUuid = this.newUuid();
        const correlationId = input.correlationId ?? runUuid;
        const fileSha256 = crypto.createHash("sha256").update(fs.readFileSync(input.ifcPath)).digest("hex");
        let projectFindings = input.projectFindings ?? [];
        if (input.projectValidator) {
            const project = await input.projectValidator.validate(input.extractedModel, input.context);
            projectFindings = normalizeProject(project.findings);
        }
        const projectStatus = projectFindings.some((finding) => finding.status === "fail") ? "fail" : "pass";

        if (this.config.mode === "disabled") {
            return {
                runUuid, correlationId, mode: "disabled",
                overallStatus: projectStatus, idsStatus: "not_evaluated", projectRulesStatus: projectStatus,
                blocking: projectStatus === "fail", fileSha256, ifcSchema: input.extractedModel.schema,
                profile: null, executor: null, findings: projectFindings,
                startedAt: started.toISOString(), completedAt: this.now().toISOString(),
            };
        }

        const profile = input.profileOverride ?? await this.profiles.resolveActive(this.config.familyKey);
        console.log(JSON.stringify({ type: "ids_validation_started", correlationId, profileArtifactUuid: profile.artifactUuid,
            profileVersion: profile.version, fileHash: fileSha256, modelVersionId: input.context.modelVersionId || null,
            mode: this.config.mode, at: started.toISOString() }));
        let ids;
        try {
            ids = await this.provider.validate({ ifcPath: input.ifcPath, profile, correlationId, timeoutMs: this.config.timeoutMs });
        } catch (error: any) {
            const completedAt = this.now().toISOString();
            const finding: NormalizedRequirementFinding = {
                source: "ids", requirementId: "IDS-EXECUTION", requirementName: "IDS executor",
                status: "fail", severity: "error", entityType: null, entityGuid: null, propertySet: null,
                propertyName: null, expectedValue: null, actualValue: null,
                message: String(error?.message ?? "IDS validation could not be completed.").slice(0, 500),
            };
            const report: ModelRequirementsValidationReport = {
                runUuid, correlationId, mode: this.config.mode, overallStatus: "error", idsStatus: "error",
                projectRulesStatus: projectStatus, blocking: true, fileSha256, ifcSchema: input.extractedModel.schema,
                profile: { artifactId: profile.artifactId, artifactUuid: profile.artifactUuid, familyKey: profile.familyKey, version: profile.version, sha256: profile.sha256 },
                executor: null, findings: [finding, ...projectFindings], startedAt: started.toISOString(), completedAt,
            };
            await this.reports.persist({ report, modelVersionId: input.context.modelVersionId || null, sourceKind: input.sourceKind });
            console.error(JSON.stringify({ type: "ids_validation_failed", correlationId, profileArtifactUuid: profile.artifactUuid,
                fileHash: fileSha256, mode: this.config.mode, at: completedAt }));
            return report;
        }

        const idsStatus = ids.conforms ? "pass" : "fail";
        const blocking = projectStatus === "fail" || (this.config.mode === "required" && idsStatus === "fail");
        const completedAt = this.now().toISOString();
        const report: ModelRequirementsValidationReport = {
            runUuid, correlationId, mode: this.config.mode,
            overallStatus: blocking ? "fail" : "pass", idsStatus, projectRulesStatus: projectStatus, blocking,
            fileSha256: ids.fileSha256, ifcSchema: ids.ifcSchema,
            profile: { artifactId: profile.artifactId, artifactUuid: profile.artifactUuid, familyKey: profile.familyKey, version: profile.version, sha256: profile.sha256 },
            executor: { name: ids.executorName, version: ids.executorVersion },
            findings: [...ids.findings, ...projectFindings], startedAt: started.toISOString(), completedAt,
        };
        await this.reports.persist({ report, modelVersionId: input.context.modelVersionId || null, sourceKind: input.sourceKind });
        const durationMs = this.now().getTime() - started.getTime();
        console.log(JSON.stringify({ type: "ids_validation_completed", correlationId, profileArtifactUuid: profile.artifactUuid,
            profileVersion: profile.version, fileHash: ids.fileSha256, modelVersionId: input.context.modelVersionId || null,
            mode: this.config.mode, durationMs, passCount: report.findings.filter((x) => x.status === "pass").length,
            failCount: report.findings.filter((x) => x.status === "fail").length, at: completedAt }));
        console.log(JSON.stringify({ type: "model_requirements_validation_completed", correlationId,
            overallStatus: report.overallStatus, idsStatus, projectRulesStatus: projectStatus, mode: this.config.mode, at: completedAt }));
        return report;
    }
}
