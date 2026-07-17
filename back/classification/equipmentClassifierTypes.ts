/**
 * Contratos do classificador de candidatos a equipamento gerido (revisão do
 * Prompt 4). A classificação é uma responsabilidade de DOMÍNIO no Node.js —
 * o Python apenas extrai os dados; nenhuma lista de classes deve existir
 * fora deste módulo (nem em upload service, resolver, database, routes,
 * frontend ou policies).
 *
 * A classificação NÃO decide reservabilidade (isso é do ReservabilityEvaluator)
 * e NÃO decide identidade (isso é do AssetIdentityResolver).
 */

export type EquipmentClassification =
    | "managed_equipment"
    | "architectural_element"
    | "structural_element"
    | "space"
    | "ignored_element"
    | "undetermined"
    | "invalid_proxy";

export interface IfcElementCandidate {
    guid: string;
    /** Classe IFC declarada (ex.: IfcBoiler, IfcBuildingElementProxy). */
    ifcClass: string;
    name?: string | null;
    predefinedType?: string | null;
    objectType?: string | null;
    tag?: string | null;
    psets?: Record<string, Record<string, unknown>> | null;
}

export interface ModelClassificationContext {
    modelId: number;
    modelVersionId: number;
    linkedModelId: number | null;
}

export interface EquipmentClassificationResult {
    classification: EquipmentClassification;
    classifierId: string;
    rulesVersion: string;
    ifcClass: string;
    predefinedType: string | null;
    objectType: string | null;
    tag: string | null;
    /** Campos efetivamente consultados para decidir. */
    metadataUsed: string[];
    reasons: string[];
    classifiedAt: string;
}

export interface ManagedEquipmentCandidateClassifier {
    classify(
        candidate: IfcElementCandidate,
        context: ModelClassificationContext
    ): EquipmentClassificationResult;
}
