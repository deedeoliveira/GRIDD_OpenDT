import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { loadPublicArtifactManifest } from "../../semantic/publicArtifactManifest.ts";
import { ArtifactValidationService } from "../../semantic/artifactValidation.ts";
import { FilesystemArtifactSource } from "../../semantic/publicArtifactManifest.ts";
import { ArtifactRegistryService } from "../../semantic/artifactRegistryService.ts";
import { FakeSemanticArtifactDatabase } from "../helpers/fakeSemanticArtifacts.ts";

const root = path.resolve(process.cwd(), "../semantic/artifacts");

test("public manifest governs IDS/XML as file-executed and preserves RDF graph storage", async () => {
    const manifest = await loadPublicArtifactManifest(path.join(root, "semantic-artifacts-public-manifest.json"));
    const ids = manifest.artifacts.find((entry) => entry.artifactType === "ids_profile")!;
    assert.equal(ids.storageMode, "file_executed");
    assert.equal(ids.mediaType, "application/ids+xml");
    assert.equal(ids.serialization, "ids-xml");
    assert.equal(ids.testOnly, false);
    assert.ok(manifest.artifacts.filter((entry) => entry.artifactType !== "ids_profile").every((entry) => entry.storageMode === "graph_backed"));
    await new ArtifactValidationService(new FilesystemArtifactSource(root)).validateManifestTree(manifest);
});

test("IDS revision activates with a current pointer and never receives a named graph", async () => {
    const manifest = await loadPublicArtifactManifest(path.join(root, "semantic-artifacts-public-manifest.json"));
    const entry = manifest.artifacts.find((candidate) => candidate.artifactType === "ids_profile")!;
    const validated = await new ArtifactValidationService(new FilesystemArtifactSource(root)).validate(entry, true);
    const database = new FakeSemanticArtifactDatabase();
    const registry = new ArtifactRegistryService(database, { newUuid: (() => {
        let value = 0;
        return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
    })() });
    const registered = await registry.registerLoad({
        entry, integrity: validated.summary, baseUri: "http://oswadt.test/id", idempotencyKey: "ids-activate", activate: true,
    });
    assert.equal(registered.artifact.storage_mode, "file_executed");
    assert.equal(registered.artifact.named_graph_uri, null);
    await database.markFileVerified(registered.operation.operation_uuid, Number(registered.artifact.id), { executor: { name: "IfcTester" } });
    await database.activateArtifact({ operationUuid: registered.operation.operation_uuid, familyId: Number(registered.family.id), artifactId: Number(registered.artifact.id), expectedCurrentArtifactId: null });
    assert.equal(database.families[0]!.current_artifact_id, registered.artifact.id);
    assert.equal(database.artifacts[0]!.lifecycle_status, "active");
});
