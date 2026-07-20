import path from "node:path";
import { extractIfcModelFromFile } from "./ifcFileExtraction.ts";
import { validateDemoProjectRules } from "./demoProjectRules.ts";
import { ModelRequirementsValidationService } from "./modelRequirementsValidationService.ts";
import type { ModelRequirementsValidationReport } from "./modelRequirementsValidationReport.ts";

export const IDS_DEMO_SCENARIOS = {
    "invalid-missing-reference": {
        title: "Scenario A — Missing Reference",
        filename: "ids-demo-invalid-missing-reference.ifc",
        explanation: "The IFC space does not provide the Reference property required by the active IDS profile.",
    },
    "valid": {
        title: "Scenario B — Valid model",
        filename: "ids-demo-valid.ifc",
        explanation: "The IFC satisfies the active IDS profile and the project uniqueness rule.",
    },
    "duplicate-reference": {
        title: "Scenario C — Duplicate Reference",
        filename: "ids-demo-duplicate-reference.ifc",
        explanation: "Each space contains a Reference, so IDS passes; the project rule fails because two spaces use the same persistent identity code.",
    },
} as const;

export type IdsDemoScenario = keyof typeof IDS_DEMO_SCENARIOS;

export function isIdsDemoScenario(value: string): value is IdsDemoScenario {
    return Object.prototype.hasOwnProperty.call(IDS_DEMO_SCENARIOS, value);
}

export async function runIdsDemoScenario(
    scenario: IdsDemoScenario,
    validation = new ModelRequirementsValidationService()
): Promise<{ scenario: IdsDemoScenario; title: string; explanation: string; report: ModelRequirementsValidationReport }> {
    const descriptor = IDS_DEMO_SCENARIOS[scenario];
    const ifcPath = path.resolve(process.cwd(), "tests", "fixtures", "ids", descriptor.filename);
    const extracted = await extractIfcModelFromFile(ifcPath);
    const report = await validation.validate({
        ifcPath,
        extractedModel: extracted,
        context: { linkedModelId: null, modelId: 0, modelVersionId: 0 },
        projectFindings: validateDemoProjectRules(extracted),
        sourceKind: "demo",
    });
    console.log(JSON.stringify({
        type: "ids_demo_scenario_executed",
        correlationId: report.correlationId,
        scenario,
        overallStatus: report.overallStatus,
        idsStatus: report.idsStatus,
        projectRulesStatus: report.projectRulesStatus,
        at: new Date().toISOString(),
    }));
    return { scenario, title: descriptor.title, explanation: descriptor.explanation, report };
}
