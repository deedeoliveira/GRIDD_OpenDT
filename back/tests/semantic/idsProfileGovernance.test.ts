import assert from "node:assert/strict";
import test from "node:test";
import { IdsProfileGovernanceService } from "../../requirements/idsProfileGovernanceService.ts";
import type { IdsProfileMetadata, IdsValidationProvider } from "../../requirements/idsValidationTypes.ts";
import { FakeSemanticArtifactDatabase } from "../helpers/fakeSemanticArtifacts.ts";

function fakeProvider(): IdsValidationProvider {
    return {
        async validate() {
            throw new Error("not used by governance registration tests");
        },
        async validateProfile(profile: IdsProfileMetadata) {
            return {
                profileVersion: profile.version,
                profileSha256: profile.sha256,
                executorName: "FakeIfcTester",
                executorVersion: "0.0.0-test",
                specificationCount: 1,
            };
        },
    };
}

test("IDS register({activate:false}) validates and completes without activating", async () => {
    const database = new FakeSemanticArtifactDatabase();
    const service = new IdsProfileGovernanceService(database, fakeProvider());

    const result = await service.register("oswadt-ifc4-model-requirements", { activate: false });

    assert.equal(database.artifacts.length, 1);
    const artifact = database.artifacts[0]!;
    assert.equal(artifact.id, result.artifactId);
    assert.equal(artifact.validation_status, "file_verified");
    assert.equal(artifact.lifecycle_status, "validated", "must not become active");

    assert.equal(database.families.length, 1);
    assert.equal(database.families[0]!.current_artifact_id, null, "current pointer must remain untouched");

    assert.equal(database.operations.length, 1);
    const operation = database.operations[0]!;
    assert.equal(operation.operation_type, "load_without_activation");
    assert.equal(operation.status, "completed");
});

test("IDS register({activate:false}) is idempotent when re-run", async () => {
    const database = new FakeSemanticArtifactDatabase();
    const service = new IdsProfileGovernanceService(database, fakeProvider());

    await service.register("oswadt-ifc4-model-requirements", { activate: false });
    const second = await service.register("oswadt-ifc4-model-requirements", { activate: false });

    assert.equal(database.artifacts.length, 1, "no duplicate artifact row");
    assert.equal(database.operations.length, 1, "idempotency key reuses the same operation");
    assert.equal(database.families[0]!.current_artifact_id, null);
    assert.equal(second.artifactId, database.artifacts[0]!.id);
});

test("IDS registerAndActivate() still activates exactly as before (regression)", async () => {
    const database = new FakeSemanticArtifactDatabase();
    const service = new IdsProfileGovernanceService(database, fakeProvider());

    const result = await service.registerAndActivate("oswadt-ifc4-model-requirements");

    const artifact = database.artifacts[0]!;
    assert.equal(artifact.lifecycle_status, "active");
    assert.equal(artifact.validation_status, "file_verified");
    assert.equal(database.families[0]!.current_artifact_id, result.artifactId);

    const operation = database.operations[0]!;
    assert.equal(operation.operation_type, "load_and_activate");
    assert.equal(operation.status, "completed");
});

test("IDS register() with no options defaults to activation", async () => {
    const database = new FakeSemanticArtifactDatabase();
    const service = new IdsProfileGovernanceService(database, fakeProvider());

    const result = await service.register("oswadt-ifc4-model-requirements");

    assert.equal(database.artifacts[0]!.lifecycle_status, "active");
    assert.equal(database.families[0]!.current_artifact_id, result.artifactId);
});

test("IDS an inactive registration can be activated later without re-registering", async () => {
    const database = new FakeSemanticArtifactDatabase();
    const service = new IdsProfileGovernanceService(database, fakeProvider());

    const inactive = await service.register("oswadt-ifc4-model-requirements", { activate: false });
    assert.equal(database.families[0]!.current_artifact_id, null);

    const activated = await service.register("oswadt-ifc4-model-requirements", { activate: true });
    assert.equal(activated.artifactId, inactive.artifactId, "same artifact row is reused, not duplicated");
    assert.equal(database.artifacts.length, 1);
    assert.equal(database.artifacts[0]!.lifecycle_status, "active");
    assert.equal(database.families[0]!.current_artifact_id, inactive.artifactId);
});
