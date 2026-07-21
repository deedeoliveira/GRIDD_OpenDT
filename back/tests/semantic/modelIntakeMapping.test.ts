import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadPublicArtifactManifest } from "../../semantic/publicArtifactManifest.ts";
import { ArtifactValidationService } from "../../semantic/artifactValidation.ts";
import { FilesystemArtifactSource } from "../../semantic/publicArtifactManifest.ts";
import { validateMappingProfile } from "../../modelIntake/mappingProfileService.ts";

const root = path.resolve(process.cwd(), "../semantic/artifacts");

test("the public manifest governs the JSON mapping as active-eligible file execution with no named graph", async () => {
    const manifest = await loadPublicArtifactManifest(path.join(root, "semantic-artifacts-public-manifest.json"));
    const mapping = manifest.artifacts.find((item) => item.artifactType === "ifc_rdf_mapping");
    assert.ok(mapping);
    assert.equal(mapping.storageMode, "file_executed");
    assert.equal(mapping.mediaType, "application/json");
    assert.equal(mapping.serialization, "json");
    assert.equal(mapping.tripleCount, 0);
    assert.equal(mapping.activationAllowed, true);
    await new ArtifactValidationService(new FilesystemArtifactSource(root)).validate(mapping, true);
});

test("the declarative mapping allows only the selected BOT/BEO/PROV/DCT/project namespaces and explicitly excludes broad or private content", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "runtime/oswadt-ifc4-minimal-rdf-mapping/1.0.0/oswadt-ifc4-minimal-rdf-mapping-v1.json"), "utf8"));
    const profile = validateMappingProfile(raw);
    assert.deepEqual(Object.keys(profile.namespaces).sort(), ["beo", "bot", "dcterms", "project", "prov"]);
    for (const excluded of ["geometry", "full ifcOWL", "reservations", "actor links", "institutional data", "SHACL results", "credentials", "filesystem paths"]) {
        assert.ok(profile.deliberatelyExcluded.includes(excluded));
    }
    assert.equal(profile.executionModel, "declarative_allowlist");
});

test("a mapping with an external namespace or executable model is rejected", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "runtime/oswadt-ifc4-minimal-rdf-mapping/1.0.0/oswadt-ifc4-minimal-rdf-mapping-v1.json"), "utf8"));
    assert.throws(() => validateMappingProfile({ ...raw, namespaces: { ...raw.namespaces, evil: "https://example.test/" } }), /namespaces/);
    assert.throws(() => validateMappingProfile({ ...raw, executionModel: "javascript" }), /execution model/);
});
