import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { IfcOpenShellIdsValidationProvider } from "../../requirements/ifcOpenShellIdsValidationProvider.ts";
import type { IdsProfileMetadata } from "../../requirements/idsValidationTypes.ts";

const profile: IdsProfileMetadata = {
    artifactId: 1,
    artifactUuid: "00000000-0000-4000-8000-000000000001",
    familyKey: "oswadt-ifc4-model-requirements",
    version: "1.0.0",
    sha256: "bf4c585d3df7d7cd876d21f43d23282c45575b4b105925d96e4254fa9b076028",
    absolutePath: path.resolve(process.cwd(), "../semantic/artifacts/runtime/oswadt-ifc4-model-requirements/1.0.0/oswadt-ifc4-model-requirements-v1.ids"),
};

const fixture = (name: string) => path.resolve(process.cwd(), "tests/fixtures/ids", name);

test("IfcTester loads the governed IDS profile with matching version and hash", async () => {
    const result = await new IfcOpenShellIdsValidationProvider().validateProfile(profile, "profile-test", 30000);
    assert.equal(result.executorName, "IfcTester");
    assert.equal(result.executorVersion, "0.8.4");
    assert.equal(result.profileVersion, "1.0.0");
    assert.equal(result.profileSha256, profile.sha256);
    assert.equal(result.specificationCount, 3);
});

test("real IDS execution rejects a space without Reference with a friendly finding", async () => {
    const result = await new IfcOpenShellIdsValidationProvider().validate({
        ifcPath: fixture("ids-demo-invalid-missing-reference.ifc"), profile, correlationId: "missing", timeoutMs: 30000,
    });
    assert.equal(result.conforms, false);
    assert.equal(result.ifcSchema, "IFC4");
    assert.ok(result.findings.some((finding) => finding.message === "The space is missing Pset_SpaceCommon.Reference."));
});

test("real IDS execution accepts valid and duplicate-reference fixtures individually", async () => {
    const provider = new IfcOpenShellIdsValidationProvider();
    for (const name of ["ids-demo-valid.ifc", "ids-demo-duplicate-reference.ifc"]) {
        const result = await provider.validate({ ifcPath: fixture(name), profile, correlationId: name, timeoutMs: 30000 });
        assert.equal(result.conforms, true, name);
        assert.ok(result.requirementsEvaluated >= 3);
        assert.equal(result.failureCount, 0);
    }
});

test("malformed IDS and incompatible IFC errors are controlled", async () => {
    const provider = new IfcOpenShellIdsValidationProvider();
    await assert.rejects(
        provider.validate({ ifcPath: profile.absolutePath, profile, correlationId: "wrong-file", timeoutMs: 30000 }),
        (error: any) => error.code === "ids_executor_failed" && !String(error.message).includes("Traceback")
    );
    await assert.rejects(
        provider.validate({ ifcPath: fixture("ids-demo-valid.ifc"), profile, correlationId: "timeout", timeoutMs: 1 }),
        (error: any) => new Set(["ids_executor_timeout", "ids_executor_failed"]).has(error.code)
    );
});
