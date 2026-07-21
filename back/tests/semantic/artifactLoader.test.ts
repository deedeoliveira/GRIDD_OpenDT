import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { GraphConfig } from "../../graph/graphConfig.ts";
import { ArtifactLoaderService } from "../../semantic/artifactLoaderService.ts";
import { ArtifactRegistryService } from "../../semantic/artifactRegistryService.ts";
import { ArtifactValidationService } from "../../semantic/artifactValidation.ts";
import {
    SemanticArtifactError,
    type PublicArtifactManifest,
    type PublicArtifactManifestEntry,
    type SemanticArtifactLogger,
} from "../../semantic/artifactTypes.ts";
import { FilesystemArtifactSource, parsePublicArtifactManifest } from "../../semantic/publicArtifactManifest.ts";
import { FakeSemanticArtifactDatabase, FakeSemanticGraphClient, MemoryArtifactSource } from "../helpers/fakeSemanticArtifacts.ts";

const artifactRoot = path.resolve(import.meta.dirname, "../../../semantic/artifacts");
const publicManifest = parsePublicArtifactManifest(fs.readFileSync(
    path.join(artifactRoot, "semantic-artifacts-public-manifest.json"),
    "utf8"
));
const graphConfig: GraphConfig = {
    provider: "fake",
    queryEndpoint: "http://127.0.0.1:3030/oswadt-test/query",
    updateEndpoint: "http://127.0.0.1:3030/oswadt-test/update",
    dataEndpoint: "http://127.0.0.1:3030/oswadt-test/data",
    username: null,
    password: null,
    requestTimeoutMs: 1_000,
    baseUri: "https://example.test/id",
};
const logger: SemanticArtifactLogger = { info() {}, error() {} };

function uuidSequence(): () => string {
    let value = 100;
    return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

function realSetup() {
    const source = new FilesystemArtifactSource(artifactRoot);
    const counts = new Map<string, number>();
    for (const entry of publicManifest.artifacts) counts.set(entry.sha256, entry.tripleCount);
    const graph = new FakeSemanticGraphClient((payload) => counts.get(crypto.createHash("sha256").update(payload).digest("hex")) ?? -1);
    const database = new FakeSemanticArtifactDatabase();
    const registry = new ArtifactRegistryService(database, { newUuid: uuidSequence() });
    const loader = new ArtifactLoaderService(
        publicManifest,
        new ArtifactValidationService(source, () => new Date("2026-07-20T00:00:00.000Z")),
        registry,
        graphConfig,
        graph,
        logger,
        true
    );
    return { database, graph, loader };
}

test("load-public loads and activates exactly the seven graph-backed runtime artifacts", async () => {
    const { database, graph, loader } = realSetup();
    const results = await loader.loadPublic();

    assert.equal(results.length, 7);
    assert.equal(graph.putCalls.length, 7);
    assert.equal(database.families.filter((family) => family.current_artifact_id !== null).length, 7);
    assert.ok(results.every((result) => result.status === "completed"));
    assert.ok(graph.putCalls.every((call) => !call.graphUri.includes("/graph/operational")));
    assert.ok(graph.putCalls.every((call) => !call.graphUri.includes("/graph/test/")));
});

test("ontology, bridge, shapes, and synthetic data use their governed graph namespaces", async () => {
    const { graph, loader } = realSetup();
    for (const entry of publicManifest.artifacts.filter((item) => item.storageMode === "graph_backed" && !item.testOnly)) {
        await loader.load({ artifactKey: entry.artifactKey, idempotencyKey: `load:${entry.artifactKey}` });
    }

    const uris = graph.putCalls.map((call) => call.graphUri);
    assert.ok(uris.some((uri) => uri.includes("/graph/vocabularies/institutional-ontology/")));
    assert.ok(uris.some((uri) => uri.includes("/graph/vocabularies/project-institutional-bridge/")));
    assert.ok(uris.some((uri) => uri.includes("/graph/validation/shapes/")));
    assert.ok(uris.some((uri) => uri.includes("/graph/institutional-data/synthetic/")));
});

test("shape loading records parsing and graph verification but no SHACL execution claim", async () => {
    const { database, loader } = realSetup();
    const entry = publicManifest.artifacts.find((item) => item.artifactType === "shacl_shapes")!;
    await loader.load({ artifactKey: entry.artifactKey, idempotencyKey: "load:shapes" });

    const summary = JSON.stringify(database.artifacts[0]?.validation_summary_json);
    assert.match(summary, /fuseki_parsing_loading_validation/);
    assert.match(summary, /post_load_graph_verification/);
    assert.doesNotMatch(summary, /SHACL validated|shacl_executed/i);
});

test("negative fixture is denied by normal loading and isolated in a test graph by a harness", async () => {
    const { database, graph, loader } = realSetup();
    const entry = publicManifest.artifacts.find((item) => item.artifactType === "test_fixture")!;
    await assert.rejects(
        loader.load({ artifactKey: entry.artifactKey, idempotencyKey: "negative:denied", activate: false }),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "artifact_activation_forbidden"
    );

    const result = await loader.load({
        artifactKey: entry.artifactKey,
        idempotencyKey: "negative:test-harness",
        activate: false,
        allowTestFixture: true,
        testRunUuid: "00000000-0000-4000-8000-000000000999",
    });
    assert.match(result.graphUri!, /\/graph\/test\/00000000-0000-4000-8000-000000000999\/negative\//);
    assert.equal(database.families[0]?.current_artifact_id, null);
    assert.equal(graph.deleteCalls.length, 0);
});

test("post-load triple-count mismatch is terminal and never activates", async () => {
    const source = new FilesystemArtifactSource(artifactRoot);
    const graph = new FakeSemanticGraphClient(() => 0);
    const database = new FakeSemanticArtifactDatabase();
    const loader = new ArtifactLoaderService(
        publicManifest,
        new ArtifactValidationService(source),
        new ArtifactRegistryService(database, { newUuid: uuidSequence() }),
        graphConfig,
        graph,
        logger,
        true
    );
    const entry = publicManifest.artifacts[0]!;

    await assert.rejects(
        loader.load({ artifactKey: entry.artifactKey, idempotencyKey: "count:mismatch" }),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "graph_verification_failed"
    );
    assert.equal(database.operations[0]?.status, "failed_terminal");
    assert.equal(database.families[0]?.current_artifact_id, null);
});

test("Fuseki unavailability is retryable and sanitized", async () => {
    const { database, graph, loader } = realSetup();
    graph.failPut = true;
    const entry = publicManifest.artifacts[0]!;

    await assert.rejects(
        loader.load({ artifactKey: entry.artifactKey, idempotencyKey: "fuseki:down" }),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "graph_load_failed" && error.retryable
    );
    assert.equal(database.operations[0]?.status, "failed_retryable");
    assert.equal(database.families[0]?.current_artifact_id, null);
    assert.doesNotMatch(database.operations[0]?.error_message ?? "", /password|SELECT|INSERT|ttl payload/i);
});

test("graph written plus SQL failure retries with the same artifact and graph URI", async () => {
    const { database, graph, loader } = realSetup();
    database.failMarkGraphVerifiedOnce = true;
    const entry = publicManifest.artifacts[0]!;
    let operationUuid = "";

    await assert.rejects(loader.load({ artifactKey: entry.artifactKey, idempotencyKey: "sql:after-graph" }));
    operationUuid = database.operations[0]!.operation_uuid;
    const artifactUuid = database.artifacts[0]!.artifact_uuid;
    const graphUri = database.artifacts[0]!.named_graph_uri;
    assert.ok(graph.graphs.has(graphUri!));

    const result = await loader.retry(operationUuid);
    assert.equal(result.artifactUuid, artifactUuid);
    assert.equal(result.graphUri, graphUri);
    assert.equal(result.status, "completed");
    assert.equal(graph.putCalls.length, 2);
    assert.deepEqual(new Set(graph.putCalls.map((call) => call.graphUri)), new Set([graphUri]));
});

test("completed retry and repeated idempotent load never rewrite the graph", async () => {
    const { database, graph, loader } = realSetup();
    const entry = publicManifest.artifacts[0]!;
    const first = await loader.load({ artifactKey: entry.artifactKey, idempotencyKey: "idempotent:load" });
    await loader.retry(first.operationUuid!);
    await loader.load({ artifactKey: entry.artifactKey, idempotencyKey: "idempotent:load" });

    assert.equal(graph.putCalls.length, 1);
    assert.equal(database.artifacts.length, 1);
    assert.equal(database.operations.length, 1);
});

test("two concurrent loads with the same idempotency key perform one graph PUT", async () => {
    const { database, graph, loader } = realSetup();
    const entry = publicManifest.artifacts[0]!;
    const [first, second] = await Promise.all([
        loader.load({ artifactKey: entry.artifactKey, idempotencyKey: "concurrent:same" }),
        loader.load({ artifactKey: entry.artifactKey, idempotencyKey: "concurrent:same" }),
    ]);

    assert.equal(first.operationUuid, second.operationUuid);
    assert.equal(graph.putCalls.length, 1);
    assert.equal(database.operations.length, 1);
    assert.equal(database.families[0]?.current_artifact_id, database.artifacts[0]?.id);
});

test("same idempotency key with divergent activation intent has one controlled conflict", async () => {
    const { loader } = realSetup();
    const entry = publicManifest.artifacts[0]!;
    const outcomes = await Promise.allSettled([
        loader.load({ artifactKey: entry.artifactKey, idempotencyKey: "concurrent:divergent", activate: true }),
        loader.load({ artifactKey: entry.artifactKey, idempotencyKey: "concurrent:divergent", activate: false }),
    ]);

    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    assert.ok(rejected?.reason instanceof SemanticArtifactError);
    assert.equal(rejected.reason.code, "idempotency_conflict");
});

test("loading-disabled guard still permits integrity-only dry-run", async () => {
    const source = new FilesystemArtifactSource(artifactRoot);
    const database = new FakeSemanticArtifactDatabase();
    const graph = new FakeSemanticGraphClient(() => 0);
    const loader = new ArtifactLoaderService(
        publicManifest,
        new ArtifactValidationService(source),
        new ArtifactRegistryService(database, { newUuid: uuidSequence() }),
        graphConfig,
        graph,
        logger,
        false
    );
    const entry = publicManifest.artifacts[0]!;

    const dryRun = await loader.load({ artifactKey: entry.artifactKey, idempotencyKey: "dry-run", dryRun: true });
    assert.equal(dryRun.status, "integrity_validated_dry_run");
    await assert.rejects(
        loader.load({ artifactKey: entry.artifactKey, idempotencyKey: "disabled" }),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "loading_disabled"
    );
    assert.equal(graph.putCalls.length, 0);
});

function customEntry(version: string, payload: Buffer): PublicArtifactManifestEntry {
    return {
        ...publicManifest.artifacts[0]!,
        artifactKey: `concurrent-ontology-${version}`,
        familyName: "Concurrent synthetic ontology fixture",
        semanticVersion: version,
        relativePath: `runtime/concurrent/${version}/uminho-institutional-v1.1.ttl`,
        sha256: crypto.createHash("sha256").update(payload).digest("hex"),
        byteSize: payload.byteLength,
        tripleCount: 1,
        semanticUri: "https://example.test/ontology/concurrent",
    };
}

async function concurrencyRows() {
    const payloads = [Buffer.from("<urn:v1> <urn:p> <urn:o> ."), Buffer.from("<urn:v2> <urn:p> <urn:o> ."), Buffer.from("<urn:v3> <urn:p> <urn:o> .")];
    const entries = payloads.map((payload, index) => customEntry(`1.${index}.0`, payload));
    const manifest: PublicArtifactManifest = { ...publicManifest, artifacts: entries };
    const source = new MemoryArtifactSource(new Map(entries.map((entry, index) => [entry.relativePath, payloads[index]!] as const)));
    const database = new FakeSemanticArtifactDatabase();
    const registry = new ArtifactRegistryService(database, { newUuid: uuidSequence() });
    const validation = new ArtifactValidationService(source, () => new Date("2026-07-20T00:00:00.000Z"));
    const registered = [];
    for (const entry of entries) {
        registered.push(await registry.registerLoad({
            entry,
            integrity: (await validation.validate(entry, true)).summary,
            baseUri: graphConfig.baseUri,
            idempotencyKey: `register:${entry.semanticVersion}`,
            activate: true,
        }));
    }
    for (const row of registered) {
        await database.markGraphVerified(row.operation.operation_uuid, Number(row.artifact.id), {
            integrity: (await validation.validate(entries.find((entry) => entry.semanticVersion === row.artifact.semantic_version)!, true)).summary,
            fusekiLoading: { kind: "fuseki_parsing_loading_validation", accepted: true, graphUri: row.artifact.named_graph_uri! },
            postLoad: { kind: "post_load_graph_verification", tripleCount: 1, expectedResourcePresent: true },
        });
    }
    return { database, entries, registered };
}

test("concurrent activations have one winner, exactly one current pointer, and no lost revision", async () => {
    const { database, registered } = await concurrencyRows();
    const [first, second, third] = registered;
    await database.activateArtifact({ operationUuid: first!.operation.operation_uuid, familyId: Number(first!.family.id), artifactId: Number(first!.artifact.id), expectedCurrentArtifactId: null });

    const outcomes = await Promise.allSettled([second!, third!].map((row) => database.activateArtifact({
        operationUuid: row.operation.operation_uuid,
        familyId: Number(row.family.id),
        artifactId: Number(row.artifact.id),
        expectedCurrentArtifactId: Number(first!.artifact.id),
    })));

    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    assert.equal(database.families[0]?.current_artifact_id, second!.artifact.id);
    assert.equal(database.artifacts.length, 3);
    assert.equal(database.artifacts.filter((artifact) => artifact.lifecycle_status === "active").length, 1);
});

test("rollback racing a new activation preserves every graph and exactly one current revision", async () => {
    const { database, registered } = await concurrencyRows();
    const [first, second, third] = registered;
    await database.activateArtifact({ operationUuid: first!.operation.operation_uuid, familyId: 1, artifactId: 1, expectedCurrentArtifactId: null });
    await database.activateArtifact({ operationUuid: second!.operation.operation_uuid, familyId: 1, artifactId: 2, expectedCurrentArtifactId: 1 });

    const rollback = await database.ensureOperation({
        operationUuid: "00000000-0000-4000-8000-000000009001",
        idempotencyKey: "rollback:race",
        artifactId: Number(first!.artifact.id),
        operationType: "rollback_activation",
        payloadHash: "c".repeat(64),
        previousArtifactId: Number(second!.artifact.id),
    });
    const outcomes = await Promise.allSettled([
        database.activateArtifact({ operationUuid: rollback.operation_uuid, familyId: 1, artifactId: 1, expectedCurrentArtifactId: 2 }),
        database.activateArtifact({ operationUuid: third!.operation.operation_uuid, familyId: 1, artifactId: 3, expectedCurrentArtifactId: 2 }),
    ]);

    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(database.artifacts.length, 3);
    assert.equal(database.artifacts.filter((artifact) => artifact.lifecycle_status === "active").length, 1);
    assert.ok([1, 3].includes(Number(database.families[0]?.current_artifact_id)));
});
