import type {
    EquipmentClassificationResult,
    IfcElementCandidate,
    ManagedEquipmentCandidateClassifier,
    ModelClassificationContext,
} from "./equipmentClassifierTypes.ts";
import { isValidEquipmentTag, describeInvalidTag } from "./equipmentTag.ts";

/**
 * Classificador do perfil atual do projeto (IFC4).
 *
 * Intenção do domínio: equipamento gerido = elemento operacional que não é
 * espaço nem elemento arquitetónico/estrutural. Essa intenção NÃO é usada
 * como algoritmo: as listas abaixo vêm da AUDITORIA das classes efetivamente
 * presentes nos modelos/fixtures do projeto (2026-07-17) + da taxonomia IFC4
 * para as famílias arquitetónica/estrutural bem conhecidas. Classes fora das
 * listas resultam em 'undetermined' — que NUNCA é silenciosamente ignorado
 * (fica em diagnóstico para decisão humana/extensão do perfil).
 *
 * Regra específica do IfcBuildingElementProxy (decisão do perfil):
 *  - sem ObjectType válido                        → invalid_proxy;
 *  - com ObjectType mas sem Tag EQP- válida       → invalid_proxy;
 *  - com ObjectType e Tag EQP- válida             → managed_equipment.
 * Um proxy nunca é classificado automaticamente como arquitetónico,
 * estrutural ou ignorado. PredefinedType/Name/Description NÃO substituem
 * o ObjectType.
 *
 * O que este módulo NÃO faz: reservabilidade (ReservabilityEvaluator),
 * identidade (AssetIdentityResolver), requisitos (model_requirements_preflight).
 */

const SPACE_CLASSES = new Set(["IfcSpace"]);

/** IFC4 — envelope/arquitetura (taxonomia padrão). */
const ARCHITECTURAL_CLASSES = new Set([
    "IfcWall", "IfcWallStandardCase", "IfcDoor", "IfcWindow", "IfcSlab",
    "IfcRoof", "IfcStair", "IfcStairFlight", "IfcRamp", "IfcRampFlight",
    "IfcRailing", "IfcCovering", "IfcCurtainWall", "IfcPlate", "IfcShadingDevice",
]);

/** IFC4 — estrutura (taxonomia padrão). */
const STRUCTURAL_CLASSES = new Set([
    "IfcColumn", "IfcBeam", "IfcMember", "IfcFooting", "IfcPile",
    "IfcReinforcingBar", "IfcReinforcingMesh", "IfcTendon", "IfcTendonAnchor",
]);

/** Elementos não-físicos/vazios: nunca são ativos operacionais. */
const IGNORED_CLASSES = new Set(["IfcOpeningElement", "IfcVirtualElement"]);

/**
 * Equipamento gerido — classes AUDITADAS nos modelos reais e fixtures
 * (IfcBoiler, IfcUnitaryEquipment, IfcElectricAppliance, IfcLightFixture,
 * IfcOutlet) + família de mobiliário + IfcSensor (usado nas fixtures de
 * teste; a reservabilidade continua a ser decidida pela política, que na
 * regra legada o nega — a classificação não muda isso).
 */
const MANAGED_EQUIPMENT_CLASSES = new Set([
    "IfcFurniture", "IfcFurnishingElement", "IfcSystemFurnitureElement",
    "IfcBoiler", "IfcUnitaryEquipment", "IfcElectricAppliance",
    "IfcLightFixture", "IfcOutlet", "IfcSensor",
]);

function hasValidObjectType(objectType: unknown): objectType is string {
    return typeof objectType === "string" && objectType.trim().length > 0;
}

export class ProjectProfileEquipmentClassifier implements ManagedEquipmentCandidateClassifier {
    static readonly ID = "project-profile-equipment-classifier";
    static readonly RULES_VERSION = "prompt4rev-2026-07";

    classify(candidate: IfcElementCandidate, _context: ModelClassificationContext): EquipmentClassificationResult {
        const base = {
            classifierId: ProjectProfileEquipmentClassifier.ID,
            rulesVersion: ProjectProfileEquipmentClassifier.RULES_VERSION,
            ifcClass: candidate.ifcClass,
            predefinedType: candidate.predefinedType ?? null,
            objectType: candidate.objectType ?? null,
            tag: candidate.tag ?? null,
            classifiedAt: new Date().toISOString(),
        };

        /* ---- regra específica do proxy, ANTES das regras genéricas ---- */
        if (candidate.ifcClass === "IfcBuildingElementProxy") {
            if (!hasValidObjectType(candidate.objectType)) {
                return {
                    ...base, classification: "invalid_proxy",
                    metadataUsed: ["ifcClass", "objectType"],
                    reasons: ["IfcBuildingElementProxy without a valid ObjectType (PredefinedType/Name do not substitute it)"],
                };
            }
            if (!isValidEquipmentTag(candidate.tag)) {
                return {
                    ...base, classification: "invalid_proxy",
                    metadataUsed: ["ifcClass", "objectType", "tag"],
                    reasons: [`IfcBuildingElementProxy with ObjectType '${candidate.objectType!.trim()}' but ${describeInvalidTag(candidate.tag)}`],
                };
            }
            return {
                ...base, classification: "managed_equipment",
                metadataUsed: ["ifcClass", "objectType", "tag"],
                reasons: ["IfcBuildingElementProxy with valid ObjectType and valid EQP- Tag → managed equipment (profile rule)"],
            };
        }

        /* ---- classificação normal, exclusivamente pela classe IFC ---- */
        const metadataUsed = ["ifcClass"];

        if (SPACE_CLASSES.has(candidate.ifcClass)) {
            return { ...base, classification: "space", metadataUsed, reasons: ["IfcSpace is a spatial element"] };
        }
        if (ARCHITECTURAL_CLASSES.has(candidate.ifcClass)) {
            return { ...base, classification: "architectural_element", metadataUsed, reasons: [`${candidate.ifcClass} is an architectural element (IFC4 taxonomy)`] };
        }
        if (STRUCTURAL_CLASSES.has(candidate.ifcClass)) {
            return { ...base, classification: "structural_element", metadataUsed, reasons: [`${candidate.ifcClass} is a structural element (IFC4 taxonomy)`] };
        }
        if (IGNORED_CLASSES.has(candidate.ifcClass)) {
            return { ...base, classification: "ignored_element", metadataUsed, reasons: [`${candidate.ifcClass} is a non-physical/void element`] };
        }
        if (MANAGED_EQUIPMENT_CLASSES.has(candidate.ifcClass)) {
            return { ...base, classification: "managed_equipment", metadataUsed, reasons: [`${candidate.ifcClass} is an audited managed-equipment class of the current profile`] };
        }

        return {
            ...base, classification: "undetermined", metadataUsed,
            reasons: [`${candidate.ifcClass} is not covered by the current project profile — requires human/profile decision (not silently ignored)`],
        };
    }
}
