import type {
    ExtractedIfcModel,
    ModelInformationRequirementsValidator,
    ModelRequirementsContext,
    ModelRequirementsValidationResult,
    RequirementFinding,
} from "./modelRequirementsTypes.ts";
import { runSpatialPreflight, SpatialPreflightError } from "../services/spatialPreflightService.ts";
import { validateProxyRequirements, PROXY_VALIDATOR_ID } from "./proxyRequirementsValidator.ts";
import { validateEquipmentRequirements, EQUIPMENT_VALIDATOR_ID } from "./equipmentRequirementsValidator.ts";

/**
 * Provider "project-profile-v1": current project information-requirement
 * profile (perfil IFC4), executado pelo model_requirements_preflight.
 *
 * Orquestra validadores INDEPENDENTES e modulares:
 *  - SpatialInformationRequirementsValidator  → services/spatialPreflightService
 *    (SPACE-001..003; regra estrita apenas no modelo espacial autoritativo);
 *  - ProxyInformationRequirementsValidator    → requirements/proxyRequirementsValidator
 *    (PROXY-001..003; qualquer proxy, em qualquer modelo);
 *  - EquipmentInformationRequirementsValidator→ requirements/equipmentRequirementsValidator
 *    (EQUIPMENT-001..003; qualquer modelo com candidatos managed_equipment).
 *
 * Nenhuma destas regras é IDS. A arquitetura permite registar futuramente um
 * IdsModelRequirementsValidator sem alterar o upload nem a identidade.
 */

export const PROJECT_PROFILE_ID = "project-profile-v1";
export const PROJECT_PROFILE_VERSION = "2026-07";

/** Mapeamento estável dos códigos do validador espacial para requirement IDs. */
const SPATIAL_REQUIREMENT_IDS: Record<string, string> = {
    no_ifcspace: "SPACE-001",
    invalid_references: "SPACE-002",
    duplicate_references: "SPACE-003",
};

export class ProjectProfileRequirementsValidator implements ModelInformationRequirementsValidator {
    static readonly ID = "project-profile-requirements-validator";

    async validate(
        model: ExtractedIfcModel,
        context: ModelRequirementsContext
    ): Promise<ModelRequirementsValidationResult> {
        const findings: RequirementFinding[] = [];

        /* ---- requisitos espaciais (validador modular preservado) ---- */
        try {
            await runSpatialPreflight({
                linkedModelId: context.linkedModelId,
                modelId: context.modelId,
                modelVersionId: context.modelVersionId,
                inventoryData: model.inventoryData,
            });
        } catch (error: any) {
            if (!(error instanceof SpatialPreflightError)) throw error;
            findings.push({
                requirementId: SPATIAL_REQUIREMENT_IDS[error.code] ?? "SPACE-000",
                severity: "error",
                message: error.message,
                details: {
                    validatorId: "spatial-information-requirements",
                    failureReason: error.failureReason,
                    diagnostics: error.diagnostics,
                },
            });
        }

        /* ---- requisitos dos proxies (PROXY-*) ---- */
        for (const finding of validateProxyRequirements(model, context)) {
            findings.push({ ...finding, details: { ...finding.details, validatorId: PROXY_VALIDATOR_ID } });
        }

        /* ---- requisitos dos equipamentos (EQUIPMENT-*) ---- */
        for (const finding of validateEquipmentRequirements(model, context)) {
            findings.push({ ...finding, details: { ...finding.details, validatorId: EQUIPMENT_VALIDATOR_ID } });
        }

        return {
            status: findings.some((f) => f.severity === "error") ? "does_not_conform" : "conforms",
            profileId: PROJECT_PROFILE_ID,
            profileVersion: PROJECT_PROFILE_VERSION,
            validatorId: ProjectProfileRequirementsValidator.ID,
            findings,
            evaluatedAt: new Date().toISOString(),
        };
    }
}
