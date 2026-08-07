import type { ExtractedIfcModel } from "./modelRequirementsTypes.ts";
import type { NormalizedRequirementFinding } from "./idsValidationTypes.ts";

/**
 * Demo project rule (ADR-0052 §C). The institutional inventory code is IfcSpace.Name.
 * This rule's distinct contribution is cross-instance uniqueness of the normalized
 * inventory code — something a per-entity IDS check cannot express. Missing/blank Name is
 * authoritatively enforced by the IDS profile (IDS-SPACE-NAME) and the intake gate, so it
 * is not re-reported here. Pset_SpaceCommon.Reference is NEVER read (it is ignored by the
 * whole IFC4x3 runtime). Normalization is trim + upper-case, mirroring the runtime
 * inventory-code normalization used for uniqueness.
 */
export function validateDemoProjectRules(model: ExtractedIfcModel): NormalizedRequirementFinding[] {
    const byCode = new Map<string, { guid: string; name: string | null }[]>();
    for (const [guid, space] of Object.entries(model.inventoryData)) {
        const raw = space?.spaceName;
        if (typeof raw !== "string" || raw.trim() === "") continue;
        const code = raw.trim().toUpperCase();
        if (!byCode.has(code)) byCode.set(code, []);
        byCode.get(code)!.push({ guid, name: space?.spaceName ?? null });
    }
    const duplicates = [...byCode].filter(([, spaces]) => spaces.length > 1);
    if (duplicates.length === 0) {
        return [{
            source: "project_rule",
            requirementId: "SPACE-003",
            requirementName: "Persistent space inventory codes are unique",
            status: "pass",
            severity: "info",
            entityType: "IfcSpace",
            entityGuid: null,
            propertySet: null,
            propertyName: "Name",
            expectedValue: "unique across the model",
            actualValue: null,
            message: "No duplicate persistent space inventory code was found.",
        }];
    }
    return duplicates.flatMap(([code, spaces]) => spaces.map((space) => ({
        source: "project_rule" as const,
        requirementId: "SPACE-003",
        requirementName: "Persistent space inventory codes are unique",
        status: "fail" as const,
        severity: "error" as const,
        entityType: "IfcSpace",
        entityGuid: space.guid,
        propertySet: null,
        propertyName: "Name",
        expectedValue: "unique across the model",
        actualValue: code,
        message: `Two spaces use the same institutional inventory code: ${code}.`,
    })));
}
