import type {
    ExtractedIfcModel,
    ModelRequirementsContext,
    RequirementFinding,
} from "./modelRequirementsTypes.ts";
import { getEquipmentClassifier } from "../classification/equipmentClassifierProvider.ts";
import type { IfcElementCandidate } from "../classification/equipmentClassifierTypes.ts";
import { isValidEquipmentTag, describeInvalidTag } from "../classification/equipmentTag.ts";

/**
 * Requisitos dos IfcBuildingElementProxy (regra obrigatória do perfil atual):
 *
 *  PROXY-001  todo proxy tem ObjectType não vazio;
 *  PROXY-002  todo proxy tem IfcElement.Tag válida iniciada por EQP-;
 *  PROXY-003  proxy conforme a PROXY-001/002 é classificado managed_equipment
 *             (informativo — verificado via classificador central).
 *
 * Aplica-se a QUALQUER proxy do modelo (contido em espaço ou não),
 * independentemente de o modelo ser a autoridade espacial. A regra vive num
 * componente próprio para não ser duplicada; a MESMA decisão de classificação
 * vem do classificador central (nenhuma lista/regra duplicada aqui).
 */

export const PROXY_VALIDATOR_ID = "proxy-information-requirements";

export function collectProxyCandidates(model: ExtractedIfcModel): IfcElementCandidate[] {
    const candidates: IfcElementCandidate[] = [];

    for (const space of Object.values(model.inventoryData ?? {})) {
        for (const el of ((space as any).elements ?? [])) {
            if (el.type === "IfcBuildingElementProxy") {
                candidates.push(toCandidate(el));
            }
        }
    }
    for (const el of (model.uncontainedProxies ?? [])) {
        candidates.push(toCandidate(el));
    }
    return candidates;
}

function toCandidate(el: any): IfcElementCandidate {
    return {
        guid: el.guid,
        ifcClass: el.type,
        name: el.name ?? null,
        predefinedType: el.predefinedType ?? null,
        objectType: el.objectType ?? null,
        tag: el.tag ?? null,
        psets: el.psets ?? null,
    };
}

export function validateProxyRequirements(
    model: ExtractedIfcModel,
    context: ModelRequirementsContext
): RequirementFinding[] {
    const findings: RequirementFinding[] = [];
    const classifier = getEquipmentClassifier();

    for (const candidate of collectProxyCandidates(model)) {
        const objectTypeValid = typeof candidate.objectType === "string" && candidate.objectType.trim().length > 0;

        if (!objectTypeValid) {
            findings.push({
                requirementId: "PROXY-001",
                severity: "error",
                entityGuid: candidate.guid,
                ifcClass: candidate.ifcClass,
                name: candidate.name ?? null,
                objectType: candidate.objectType ?? null,
                tag: candidate.tag ?? null,
                message: "The model contains an IfcBuildingElementProxy without a valid ObjectType.",
                details: { motivo: "missing_or_empty_object_type" },
            });
            continue;
        }

        if (!isValidEquipmentTag(candidate.tag)) {
            findings.push({
                requirementId: "PROXY-002",
                severity: "error",
                entityGuid: candidate.guid,
                ifcClass: candidate.ifcClass,
                name: candidate.name ?? null,
                objectType: candidate.objectType ?? null,
                tag: candidate.tag ?? null,
                message: "The model contains an IfcBuildingElementProxy without a valid equipment Tag starting with EQP-.",
                details: { motivo: describeInvalidTag(candidate.tag) },
            });
            continue;
        }

        // PROXY-003 (informativo/defensivo): a decisão é a do classificador
        // central — um proxy conforme tem de sair como managed_equipment.
        const classification = classifier.classify(candidate, {
            modelId: context.modelId,
            modelVersionId: context.modelVersionId,
            linkedModelId: context.linkedModelId,
        });

        if (classification.classification !== "managed_equipment") {
            findings.push({
                requirementId: "PROXY-003",
                severity: "error",
                entityGuid: candidate.guid,
                ifcClass: candidate.ifcClass,
                name: candidate.name ?? null,
                objectType: candidate.objectType ?? null,
                tag: candidate.tag ?? null,
                message: "A conforming IfcBuildingElementProxy was not classified as managed equipment — the configured classifier deviates from the profile.",
                details: { classification: classification.classification, classifierId: classification.classifierId },
            });
        }
    }

    return findings;
}
