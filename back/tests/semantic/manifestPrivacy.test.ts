import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fs } from "node:fs";
import { ArtifactValidationService } from "../../semantic/artifactValidation.ts";
import { SemanticArtifactError } from "../../semantic/artifactTypes.ts";
import {
    APPROVED_PUBLIC_SOURCE_FILENAMES,
    FilesystemArtifactSource,
    loadPublicArtifactManifest,
    parsePublicArtifactManifest,
} from "../../semantic/publicArtifactManifest.ts";

const ROOT = path.resolve("..", "semantic", "artifacts");
const MANIFEST_PATH = path.join(ROOT, "semantic-artifacts-public-manifest.json");

async function rawManifest(): Promise<any> {
    return JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
}

async function assertSemanticError(promise: Promise<unknown>, code: string): Promise<void> {
    await assert.rejects(promise, (error: unknown) => error instanceof SemanticArtifactError && error.code === code);
}

test("public manifest: five Turtle files, one governed IDS, and one governed IFC-to-RDF mapping are declared", async () => {
    const manifest = await loadPublicArtifactManifest(MANIFEST_PATH);
    assert.equal(manifest.artifacts.length, 7);
    assert.deepEqual(
        new Set(manifest.artifacts.map((entry) => entry.sourceFilename)),
        APPROVED_PUBLIC_SOURCE_FILENAMES
    );
});

test("public manifest: only public research and synthetic privacy classes occur", async () => {
    const manifest = await loadPublicArtifactManifest(MANIFEST_PATH);
    const allowed = new Set(["public_research_artifact", "synthetic_runtime_data", "synthetic_test_only"]);
    assert.ok(manifest.artifacts.every((entry) => allowed.has(entry.privacyClassification)));
});

test("integrity: all committed source hashes and byte sizes match the public manifest", async () => {
    const manifest = await loadPublicArtifactManifest(MANIFEST_PATH);
    const validation = new ArtifactValidationService(new FilesystemArtifactSource(ROOT));
    const results = await validation.validateManifestTree(manifest);
    assert.equal(results.length, 7);
    assert.ok(results.every((result) => result.summary.sha256 === result.entry.sha256));
    assert.ok(results.every((result) => result.summary.byteSize === result.entry.byteSize));
});

test("privacy tree guard: no undeclared semantic source file exists", async () => {
    const source = new FilesystemArtifactSource(ROOT);
    const files = await source.listFiles();
    const rdfFiles = files.filter((file) => /\.(ttl|ids|json|rdf|csv|sparql)$/i.test(file) && file !== "semantic-artifacts-public-manifest.json");
    assert.equal(rdfFiles.filter((file) => file.endsWith(".ttl")).length, 5);
    assert.equal(rdfFiles.filter((file) => file.endsWith(".ids")).length, 1);
    assert.equal(rdfFiles.filter((file) => file.endsWith(".json")).length, 1);
    assert.equal(rdfFiles.filter((file) => !file.endsWith(".ttl") && !file.endsWith(".ids") && !file.endsWith(".json")).length, 0);
});

test("negative fixture: test-only, synthetic and never activatable", async () => {
    const manifest = await loadPublicArtifactManifest(MANIFEST_PATH);
    const negative = manifest.artifacts.find((entry) => entry.artifactType === "test_fixture");
    assert.ok(negative);
    assert.equal(negative.testOnly, true);
    assert.equal(negative.activationAllowed, false);
    assert.equal(negative.privacyClassification, "synthetic_test_only");
});

test("manifest rejects a private privacy classification", async () => {
    const raw = await rawManifest();
    raw.artifacts[0].privacyClassification = "private_local";
    assert.throws(() => parsePublicArtifactManifest(raw), (error: unknown) => error instanceof SemanticArtifactError && error.code === "artifact_privacy_rejected");
});

test("manifest rejects path traversal", async () => {
    const raw = await rawManifest();
    raw.artifacts[0].relativePath = "../outside/uminho-institutional-v1.1.ttl";
    assert.throws(() => parsePublicArtifactManifest(raw), (error: unknown) => error instanceof SemanticArtifactError && error.code === "manifest_invalid");
});

test("manifest rejects a file outside the explicit source allowlist", async () => {
    const raw = await rawManifest();
    raw.artifacts[0].sourceFilename = "unapproved.ttl";
    raw.artifacts[0].relativePath = "runtime/unapproved.ttl";
    assert.throws(() => parsePublicArtifactManifest(raw), (error: unknown) => error instanceof SemanticArtifactError && error.code === "manifest_invalid");
});

test("manifest rejects a non-Turtle media type", async () => {
    const raw = await rawManifest();
    raw.artifacts[0].mediaType = "application/rdf+xml";
    assert.throws(() => parsePublicArtifactManifest(raw), SemanticArtifactError);
});

test("manifest rejects a non-Turtle serialization", async () => {
    const raw = await rawManifest();
    raw.artifacts[0].serialization = "rdfxml";
    assert.throws(() => parsePublicArtifactManifest(raw), SemanticArtifactError);
});

test("manifest rejects an activatable negative fixture", async () => {
    const raw = await rawManifest();
    const negative = raw.artifacts.find((entry: any) => entry.artifactType === "test_fixture");
    negative.activationAllowed = true;
    assert.throws(() => parsePublicArtifactManifest(raw), (error: unknown) => error instanceof SemanticArtifactError && error.code === "artifact_activation_forbidden");
});

test("integrity rejects a divergent hash", async () => {
    const manifest = await loadPublicArtifactManifest(MANIFEST_PATH);
    const entry = { ...manifest.artifacts[0]!, sha256: "0".repeat(64) };
    await assertSemanticError(
        new ArtifactValidationService(new FilesystemArtifactSource(ROOT)).validate(entry, false),
        "artifact_integrity_failed"
    );
});

test("integrity rejects a divergent byte size", async () => {
    const manifest = await loadPublicArtifactManifest(MANIFEST_PATH);
    const entry = { ...manifest.artifacts[0]!, byteSize: manifest.artifacts[0]!.byteSize + 1 };
    await assertSemanticError(
        new ArtifactValidationService(new FilesystemArtifactSource(ROOT)).validate(entry, false),
        "artifact_integrity_failed"
    );
});

test("integrity validation summary never claims SHACL execution", async () => {
    const manifest = await loadPublicArtifactManifest(MANIFEST_PATH);
    const result = await new ArtifactValidationService(new FilesystemArtifactSource(ROOT)).validate(manifest.artifacts[2]!, true);
    assert.doesNotMatch(JSON.stringify(result.summary), /SHACL validated|SHACL-executed/i);
});
