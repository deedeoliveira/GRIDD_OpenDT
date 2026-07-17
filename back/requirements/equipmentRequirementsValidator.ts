import type {
    ExtractedIfcModel,
    ModelRequirementsContext,
    RequirementFinding,
} from "./modelRequirementsTypes.ts";
import { getEquipmentClassifier } from "../classification/equipmentClassifierProvider.ts";
import type { IfcElementCandidate } from "../classification/equipmentClassifierTypes.ts";
import { isValidEquipmentTag, describeInvalidTag, equipmentTagDuplicateKey } from "../classification/equipmentTag.ts";

/**
 * Requisitos dos equipamentos geridos MODELADOS (perfil atual):
 *
 *  EQUIPMENT-001  todo candidato managed_equipment tem IfcElement.Tag;
 *  EQUIPMENT-002  a Tag começa por EQP- e tem conteúdo depois do prefixo
 *                 (vazia/whitespace/prefixo errado/sem sufixo → falha);
 *  EQUIPMENT-003  Tags únicas no âmbito de identidade configurado (duas
 *                 entidades distintas da mesma versão com a mesma Tag
 *                 normalizada → falha; entre modelos da federação, a mesma
 *                 Tag liga-se ao MESMO ativo persistente — nunca cria um
 *                 segundo ativo silenciosamente).
 *
 * Aplica-se a QUALQUER modelo com candidatos managed_equipment, mesmo não
 * sendo a autoridade espacial. Um modelo sem equipamentos passa. Elementos
 * arquitetónicos/estruturais/ignorados/undetermined NÃO precisam de Tag.
 * A classificação vem exclusivamente do classificador central; os proxies
 * são cobertos pelas regras PROXY-* (não duplicadas aqui) mas participam
 * da verificação de duplicação quando válidos.
 */

export const EQUIPMENT_VALIDATOR_ID = "equipment-information-requirements";

interface ClassifiedElement {
    candidate: IfcElementCandidate;
    classification: string;
}

export function classifyInventoryElements(
    model: ExtractedIfcModel,
    context: ModelRequirementsContext
): ClassifiedElement[] {
    const classifier = getEquipmentClassifier();
    const out: ClassifiedElement[] = [];

    for (const space of Object.values(model.inventoryData ?? {})) {
        for (const el of ((space as any).elements ?? [])) {
            const candidate: IfcElementCandidate = {
                guid: el.guid,
                ifcClass: el.type,
                name: el.name ?? null,
                predefinedType: el.predefinedType ?? null,
                objectType: el.objectType ?? null,
                tag: el.tag ?? null,
                psets: el.psets ?? null,
            };
            const result = classifier.classify(candidate, {
                modelId: context.modelId,
                modelVersionId: context.modelVersionId,
                linkedModelId: context.linkedModelId,
            });
            out.push({ candidate, classification: result.classification });
        }
    }
    return out;
}

export function validateEquipmentRequirements(
    model: ExtractedIfcModel,
    context: ModelRequirementsContext
): RequirementFinding[] {
    const findings: RequirementFinding[] = [];
    const classified = classifyInventoryElements(model, context);

    const managed = classified.filter((c) => c.classification === "managed_equipment");

    /* ---- EQUIPMENT-001/002: presença e formato da Tag ---- */
    for (const { candidate } of managed) {
        // Proxies são cobrados pelas regras PROXY-* (regra centralizada; um
        // proxy managed_equipment tem, por definição do perfil, Tag válida).
        if (candidate.ifcClass === "IfcBuildingElementProxy") continue;

        if (candidate.tag === null || candidate.tag === undefined) {
            findings.push(tagFinding("EQUIPMENT-001", candidate,
                "The model contains a managed equipment candidate without an IfcElement.Tag."));
            continue;
        }
        if (!isValidEquipmentTag(candidate.tag)) {
            findings.push(tagFinding("EQUIPMENT-002", candidate,
                "The model contains a managed equipment candidate whose Tag is not a valid inventory code starting with EQP-."));
        }
    }

    /* ---- EQUIPMENT-003: duplicações na mesma versão ---- */
    const byKey = new Map<string, IfcElementCandidate[]>();
    for (const { candidate } of managed) {
        if (!isValidEquipmentTag(candidate.tag)) continue;
        const key = equipmentTagDuplicateKey(candidate.tag);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key)!.push(candidate);
    }

    for (const [key, group] of byKey) {
        if (group.length > 1) {
            findings.push({
                requirementId: "EQUIPMENT-003",
                severity: "error",
                entityGuid: group.map((g) => g.guid).join(", "),
                ifcClass: group[0]!.ifcClass,
                name: group.map((g) => g.name ?? "?").join(", "),
                tag: group[0]!.tag ?? null,
                message: `Duplicate equipment inventory Tag in this model version: ${group[0]!.tag!.trim()} (${group.length} elements).`,
                details: { normalizedKey: key, guids: group.map((g) => g.guid) },
            });
        }
    }

    return findings;
}

function tagFinding(requirementId: string, candidate: IfcElementCandidate, message: string): RequirementFinding {
    return {
        requirementId,
        severity: "error",
        entityGuid: candidate.guid,
        ifcClass: candidate.ifcClass,
        name: candidate.name ?? null,
        objectType: candidate.objectType ?? null,
        tag: candidate.tag ?? null,
        message,
        details: { motivo: describeInvalidTag(candidate.tag) },
    };
}
