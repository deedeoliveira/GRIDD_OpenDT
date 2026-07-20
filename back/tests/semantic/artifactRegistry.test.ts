import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ArtifactRegistryService } from "../../semantic/artifactRegistryService.ts";
import { parsePublicArtifactManifest } from "../../semantic/publicArtifactManifest.ts";
import {
    SemanticArtifactError,
    sanitizeArtifactError,
    type IntegrityValidationSummary,
    type PublicArtifactManifestEntry,
} from "../../semantic/artifactTypes.ts";
import { FakeSemanticArtifactDatabase } from "../helpers/fakeSemanticArtifacts.ts";

const manifest = parsePublicArtifactManifest(fs.readFileSync(
    path.resolve(import.meta.dirname, "../../../semantic/artifacts/semantic-artifacts-public-manifest.json"),
    "utf8"
));
const ontology = manifest.artifacts.find((entry) => entry.artifactType === "ontology")!;

function uuidSequence(): () => string {
    let value = 0;
    return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

function integrity(entry: PublicArtifactManifestEntry): IntegrityValidationSummary {
    return {
        kind: "integrity_validation",
        sha256: entry.sha256,
        byteSize: entry.byteSize,
        expectedTripleCount: entry.tripleCount,
        mediaType: "text/turtle",
        serialization: "turtle",
        validatedAt: "2026-07-20T00:00:00.000Z",
    };
}

function setup() {
    const database = new FakeSemanticArtifactDatabase();
    const nextUuid = uuidSequence();
    const registry = new ArtifactRegistryService(database, { newUuid: nextUuid });
    return { database, registry };
}

async function register(registry: ArtifactRegistryService, entry = ontology, key = "load:ontology") {
    return registry.registerLoad({
        entry,
        integrity: integrity(entry),
        baseUri: "https://example.test/id",
        idempotencyKey: key,
        activate: true,
    });
}

test("registry creates a family, immutable revision, and operation", async () => {
    const { database, registry } = setup();
    const result = await register(registry);

    assert.equal(database.families.length, 1);
    assert.equal(database.artifacts.length, 1);
    assert.equal(database.operations.length, 1);
    assert.equal(result.artifact.validation_status, "integrity_validated");
    assert.match(result.artifact.named_graph_uri, /\/graph\/vocabularies\/institutional-ontology\/[0-9a-f-]+$/);
});

test("same family, version, hash, and idempotency payload converge", async () => {
    const { database, registry } = setup();
    const first = await register(registry);
    const second = await register(registry);

    assert.equal(second.family.id, first.family.id);
    assert.equal(second.artifact.id, first.artifact.id);
    assert.equal(second.operation.id, first.operation.id);
    assert.equal(database.artifacts.length, 1);
});

test("same family/version with a different hash fails terminally", async () => {
    const { registry } = setup();
    await register(registry);
    const changed = { ...ontology, sha256: "a".repeat(64) };

    await assert.rejects(
        register(registry, changed, "load:changed"),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "artifact_version_conflict"
    );
});

test("same family/hash under a second version is rejected as duplicate content", async () => {
    const { registry } = setup();
    await register(registry);
    const duplicate = {
        ...ontology,
        artifactKey: "uminho-institutional-ontology-1.2.0",
        semanticVersion: "1.2.0",
    };

    await assert.rejects(
        register(registry, duplicate, "load:duplicate"),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "artifact_duplicate_content"
    );
});

test("same idempotency key with a divergent operation payload conflicts", async () => {
    const { registry } = setup();
    await register(registry);

    await assert.rejects(
        registry.registerLoad({
            entry: ontology,
            integrity: integrity(ontology),
            baseUri: "https://example.test/id",
            idempotencyKey: "load:ontology",
            activate: false,
        }),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "idempotency_conflict"
    );
});

test("current pointer accepts only a graph-verified eligible revision", async () => {
    const { database, registry } = setup();
    const rows = await register(registry);

    await assert.rejects(
        database.activateArtifact({
            operationUuid: rows.operation.operation_uuid,
            familyId: Number(rows.family.id),
            artifactId: Number(rows.artifact.id),
            expectedCurrentArtifactId: null,
        }),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "activation_ineligible"
    );
    assert.equal(rows.family.current_artifact_id, null);
});

test("activation lifecycle records predecessor and supersedes the prior revision", async () => {
    const { database, registry } = setup();
    const first = await register(registry);
    await database.markGraphVerified(first.operation.operation_uuid, Number(first.artifact.id), {
        integrity: integrity(ontology),
        fusekiLoading: { kind: "fuseki_parsing_loading_validation", accepted: true, graphUri: first.artifact.named_graph_uri },
        postLoad: { kind: "post_load_graph_verification", tripleCount: ontology.tripleCount, expectedResourcePresent: true },
    });
    await database.activateArtifact({
        operationUuid: first.operation.operation_uuid,
        familyId: Number(first.family.id),
        artifactId: Number(first.artifact.id),
        expectedCurrentArtifactId: null,
    });

    const nextEntry = {
        ...ontology,
        artifactKey: "uminho-institutional-ontology-1.2.0",
        semanticVersion: "1.2.0",
        relativePath: "runtime/uminho-institutional/1.2.0/uminho-institutional-v1.2.ttl",
        sourceFilename: "uminho-institutional-v1.2.ttl",
        sha256: "b".repeat(64),
    };
    const second = await register(registry, nextEntry, "load:next");

    assert.equal(second.artifact.predecessor_artifact_id, first.artifact.id);
    assert.equal(first.artifact.lifecycle_status, "active");
});

test("sanitized errors are bounded and do not serialize causes", () => {
    const secret = "x".repeat(1_500);
    const sanitized = sanitizeArtifactError(new SemanticArtifactError("graph_load_failed", secret, true, {
        cause: { password: "must-not-be-serialized", sparql: "INSERT DATA" },
    }));

    assert.equal(sanitized.code, "graph_load_failed");
    assert.equal(sanitized.message.length, 1_000);
    assert.doesNotMatch(JSON.stringify(sanitized), /password|INSERT DATA/);
});
