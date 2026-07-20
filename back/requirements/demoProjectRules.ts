import type { ExtractedIfcModel } from "./modelRequirementsTypes.ts";
import type { NormalizedRequirementFinding } from "./idsValidationTypes.ts";

export function validateDemoProjectRules(model: ExtractedIfcModel): NormalizedRequirementFinding[] {
    const byReference = new Map<string, { guid: string; name: string | null }[]>();
    for (const [guid, space] of Object.entries(model.inventoryData)) {
        const raw = space?.psets?.Pset_SpaceCommon?.Reference;
        if (typeof raw !== "string" || raw.trim() === "") continue;
        const reference = raw.trim().toUpperCase();
        if (!byReference.has(reference)) byReference.set(reference, []);
        byReference.get(reference)!.push({ guid, name: space?.spaceName ?? null });
    }
    const duplicates = [...byReference].filter(([, spaces]) => spaces.length > 1);
    if (duplicates.length === 0) {
        return [{
            source: "project_rule",
            requirementId: "SPACE-003",
            requirementName: "Persistent space References are unique",
            status: "pass",
            severity: "info",
            entityType: "IfcSpace",
            entityGuid: null,
            propertySet: "Pset_SpaceCommon",
            propertyName: "Reference",
            expectedValue: "unique across the model",
            actualValue: null,
            message: "No duplicate persistent space Reference was found.",
        }];
    }
    return duplicates.flatMap(([reference, spaces]) => spaces.map((space) => ({
        source: "project_rule" as const,
        requirementId: "SPACE-003",
        requirementName: "Persistent space References are unique",
        status: "fail" as const,
        severity: "error" as const,
        entityType: "IfcSpace",
        entityGuid: space.guid,
        propertySet: "Pset_SpaceCommon",
        propertyName: "Reference",
        expectedValue: "unique across the model",
        actualValue: reference,
        message: `Two spaces use the same persistent identity code: ${reference}.`,
    })));
}
