import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { extractIfcModelFromFile } from "../../requirements/ifcFileExtraction.ts";
import { validateDemoProjectRules } from "../../requirements/demoProjectRules.ts";
import { ModelRequirementsValidationService } from "../../requirements/modelRequirementsValidationService.ts";
import { IfcOpenShellIdsValidationProvider } from "../../requirements/ifcOpenShellIdsValidationProvider.ts";
import type { IdsProfileMetadata } from "../../requirements/idsValidationTypes.ts";
import type { PersistValidationInput } from "../../utils/modelRequirementValidationDatabase.ts";

const profile: IdsProfileMetadata = {
    artifactId: 7,
    artifactUuid: "00000000-0000-4000-8000-000000000007",
    familyKey: "oswadt-ifc4-model-requirements",
    version: "1.0.0",
    sha256: "bf4c585d3df7d7cd876d21f43d23282c45575b4b105925d96e4254fa9b076028",
    absolutePath: path.resolve(process.cwd(), "../semantic/artifacts/runtime/oswadt-ifc4-model-requirements/1.0.0/oswadt-ifc4-model-requirements-v1.ids"),
};

test("active profile to real executor to project rules to persisted API/frontend contract", async () => {
    const persisted: PersistValidationInput[] = [];
    const reports = { persist: async (input: PersistValidationInput) => { persisted.push(input); } };
    const service = new ModelRequirementsValidationService(
        { enabled: true, mode: "required", familyKey: profile.familyKey, demoMode: true, timeoutMs: 30000 },
        new IfcOpenShellIdsValidationProvider(),
        { resolveActive: async () => profile },
        reports,
    );
    const cases = [
        ["ids-demo-invalid-missing-reference.ifc", "fail", "fail", "pass"],
        ["ids-demo-valid.ifc", "pass", "pass", "pass"],
        ["ids-demo-duplicate-reference.ifc", "fail", "pass", "fail"],
    ] as const;
    for (const [filename, overall, ids, project] of cases) {
        const ifcPath = path.resolve(process.cwd(), "tests/fixtures/ids", filename);
        const extracted = await extractIfcModelFromFile(ifcPath);
        const report = await service.validate({
            ifcPath, extractedModel: extracted, context: { linkedModelId: null, modelId: 0, modelVersionId: 0 },
            projectFindings: validateDemoProjectRules(extracted), sourceKind: "automated_test",
        });
        assert.equal(report.overallStatus, overall);
        assert.equal(report.idsStatus, ids);
        assert.equal(report.projectRulesStatus, project);
        assert.ok(report.profile?.sha256);
        assert.ok(report.executor?.version);
        assert.ok(report.findings.every((finding) => finding.source === "ids" || finding.source === "project_rule"));
    }
    assert.equal(persisted.length, 3);
    assert.deepEqual(persisted.map((item) => item.report.overallStatus), ["fail", "pass", "fail"]);
});

test("disabled, report-only, and required modes preserve their distinct decisions", async () => {
    const ifcPath = path.resolve(process.cwd(), "tests/fixtures/ids/ids-demo-invalid-missing-reference.ifc");
    const extracted = await extractIfcModelFromFile(ifcPath);
    const reports = { persist: async () => undefined };
    const common = [new IfcOpenShellIdsValidationProvider(), { resolveActive: async () => profile }, reports] as const;
    const disabled = new ModelRequirementsValidationService({ enabled: false, mode: "disabled", familyKey: profile.familyKey, demoMode: false, timeoutMs: 30000 }, ...common);
    const reportOnly = new ModelRequirementsValidationService({ enabled: true, mode: "report_only", familyKey: profile.familyKey, demoMode: false, timeoutMs: 30000 }, ...common);
    const required = new ModelRequirementsValidationService({ enabled: true, mode: "required", familyKey: profile.familyKey, demoMode: false, timeoutMs: 30000 }, ...common);
    const input = { ifcPath, extractedModel: extracted, context: { linkedModelId: null, modelId: 0, modelVersionId: 0 }, projectFindings: validateDemoProjectRules(extracted), sourceKind: "automated_test" as const };
    assert.equal((await disabled.validate(input)).idsStatus, "not_evaluated");
    assert.equal((await reportOnly.validate(input)).blocking, false);
    assert.equal((await required.validate(input)).blocking, true);
});
