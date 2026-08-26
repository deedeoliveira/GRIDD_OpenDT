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

/**
 * One lossless record per IfcSpace ENTITY (ADR-0051 Stage 0B §1). Emitted by the
 * Python extraction as an ordered list BEFORE any GlobalId-keyed collapse, so two
 * IfcSpace occurrences that share the same exact GlobalId are both retained — the
 * only way duplicate-GlobalId detection can be correct.
 */
export interface SpaceOccurrence {
    entityId: number | null;
    guid: string;
    name: string | null;
    longName: string | null;
    /**
     * Per-occurrence storey name (ADR-0051 §3-v3), derived for THIS IfcSpace entity
     * during extraction, so two occurrences sharing one GlobalId keep their own storey.
     */
    storeyName?: string | null;
    /**
     * All property sets, copied verbatim (extraction names none). The identity
     * Reference is interpreted only in the Node identity/model-intake layer, never
     * here — see the architecture guard in tests/spaces/providerGuards.test.ts.
     */
    psets: Record<string, any> | null;
}

/**
 * RZ-1 — one lossless record per IfcSpatialZone occurrence whose PredefinedType is
 * RESERVATION, extracted by `ifcopenshell_utils.extract_reservation_zone_occurrences`
 * (Python) into `build_inventory_payload()`'s additive `reservationZoneOccurrences`
 * field. This is OBSERVATIONAL IFC-extraction evidence only, in this phase — a
 * runtime-extracted candidate, not an "IDS-governed ReservationZone" and not yet the
 * future persistent operational resource (that is RZ-2's `reservation_zone_uuid`).
 * Nothing in RZ-1 persists this shape, interprets it for model-intake
 * acceptance/governance, or treats it as an IfcSpace or an asset.
 */
export interface ReservationZoneOccurrence {
    entityId: number | null;
    ifcClass: "IfcSpatialZone";
    globalId: string;
    /** Raw IFC Name, or null when absent. Missing Name never rejects model intake in RZ-1. */
    name: string | null;
    predefinedType: "RESERVATION";
    /** GlobalIds of referenced IfcSpace products (deduplicated, deterministically ordered). */
    referencedSpaceGlobalIds: string[];
}

/** Modelo extraído pelo Python (a extração não decide nada). */
export interface ExtractedIfcModel {
    /** guid do espaço → dados (formato do inventário por espaço; COLAPSA duplicados). */
    inventoryData: Record<string, any>;
    /**
     * Ocorrências lossless por IfcSpace (uma por entidade, ordenadas). Fonte ÚNICA
     * para deteção de GlobalId duplicado. Opcional para compatibilidade com fontes
     * de extração que ainda não a fornecem; nesse caso deriva-se de inventoryData
     * (uma ocorrência por chave — sem poder revelar duplicados).
     */
    spaceOccurrences?: SpaceOccurrence[];
    /** IfcBuildingElementProxy fora de qualquer IfcSpace (regras PROXY-*). */
    uncontainedProxies: any[];
    /** Schema declarado no header (perfil suportado/testado: IFC4). */
    schema: string | null;
    /**
     * RZ-1 additive evidence field (see `ReservationZoneOccurrence`). Optional for
     * compatibility with extraction sources that do not yet provide it (older Flask,
     * the controlled `ifc_extract.py` CLI path). No consumer in RZ-1 reads this for
     * acceptance/governance decisions; it is carried passively.
     */
    reservationZoneOccurrences?: ReservationZoneOccurrence[];
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
