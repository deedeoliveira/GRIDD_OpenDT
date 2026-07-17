/**
 * Requisitos de informação do modelo (model_requirements_preflight).
 *
 * As regras atuais são o "current project information-requirement profile" —
 * implementadas diretamente pela aplicação, com identificadores estáveis
 * (SPACE-001..003, EQUIPMENT-001..003, PROXY-001..003). NÃO são IDS: algumas
 * destas regras poderão futuramente ser expressas por IDS (buildingSMART),
 * mas a cobertura exata terá de ser verificada nessa implementação futura.
 *
 * A arquitetura permite um futuro IdsModelRequirementsValidator (IDS
 * registado por um gestor e associado a linked_model/model/tipo/upload) sem
 * alterar modelUploadService, identidade de espaços/ativos, reservas ou
 * frontend — basta registar outro provider.
 */

export type RequirementsStatus = "conforms" | "does_not_conform" | "error";

export type RequirementSeverity = "error" | "warning";

export interface RequirementFinding {
    requirementId: string;
    severity: RequirementSeverity;
    /** Identificação da entidade violadora, quando aplicável. */
    entityGuid?: string | null;
    ifcClass?: string | null;
    name?: string | null;
    objectType?: string | null;
    tag?: string | null;
    message: string;
    details?: Record<string, unknown>;
}

export interface ModelRequirementsValidationResult {
    status: RequirementsStatus;
    profileId: string;
    profileVersion: string;
    validatorId: string;
    findings: RequirementFinding[];
    evaluatedAt: string;
}

export interface ModelRequirementsContext {
    linkedModelId: number | null;
    modelId: number;
    modelVersionId: number;
}

/** Modelo extraído pelo Python (a extração não decide nada). */
export interface ExtractedIfcModel {
    /** guid do espaço → dados (formato do inventário por espaço). */
    inventoryData: Record<string, any>;
    /** IfcBuildingElementProxy fora de qualquer IfcSpace (regras PROXY-*). */
    uncontainedProxies: any[];
    /** Schema declarado no header (perfil suportado/testado: IFC4). */
    schema: string | null;
}

export interface ModelInformationRequirementsValidator {
    validate(
        model: ExtractedIfcModel,
        context: ModelRequirementsContext
    ): Promise<ModelRequirementsValidationResult>;
}

/** Erro estruturado devolvido ao upload (HTTP 422; nunca stack trace). */
export class ModelRequirementsError extends Error {
    readonly statusCode = 422;
    readonly uploadStage = "model_requirements_preflight";
    /** Ex.: "EQUIPMENT-001: 2 managed equipment candidate(s) without Tag". */
    readonly failureReason: string;
    readonly findings: RequirementFinding[];
    readonly profileId: string;

    constructor(userMessage: string, failureReason: string, findings: RequirementFinding[], profileId: string) {
        super(userMessage);
        this.name = "ModelRequirementsError";
        this.failureReason = failureReason;
        this.findings = findings;
        this.profileId = profileId;
    }
}
