/**
 * Historical model-version RDF materialisation regression (ADR-0052 §C/§F). Proves the
 * version graph is built from the version's SPACE-BINDING SNAPSHOTS and that the equipment
 * location edge is keyed on the PERSISTENT SPACE resource — never on the mutable current
 * inventory code — so rematerialising an old version after an IfcSpace.Name change cannot
 * rewrite its semantics, and the location link survives Name/LongName changes.
 *
 * Uses the real SemanticMaterialisationService against fake DB/graph boundaries (the strongest
 * available seam), not only a hand-built buildMinimalRdf input.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Parser } from "n3";

const storage = fs.mkdtempSync(path.join(os.tmpdir(), "oswadt-historical-"));
process.env.OSWADT_STORAGE_ROOT = storage;
process.env.IFC_RDF_MATERIALISATION_ENABLED = "true";
process.env.IFC_RDF_MATERIALISATION_MODE = "required";
process.env.IFC_RDF_MAPPING_FAMILY_KEY = "oswadt-ifc4-minimal-rdf-mapping";
process.env.SHACL_VALIDATION_ENABLED = "false";
process.env.SHACL_VALIDATION_MODE = "disabled";
process.env.GRAPH_PROVIDER = "fuseki";
process.env.GRAPH_QUERY_ENDPOINT = "http://localhost:3030/test/query";
process.env.GRAPH_UPDATE_ENDPOINT = "http://localhost:3030/test/update";
process.env.GRAPH_DATA_ENDPOINT = "http://localhost:3030/test/data";
process.env.GRAPH_BASE_URI = "http://oswadt.test/id";

const { SemanticMaterialisationService } = await import("../../modelIntake/semanticMaterialisationService.ts");
const { validateMappingProfile } = await import("../../modelIntake/mappingProfileService.ts");
const mapping = validateMappingProfile(JSON.parse(fs.readFileSync(path.resolve(
    "../semantic/artifacts/runtime/oswadt-ifc4-minimal-rdf-mapping/1.1.0/oswadt-ifc4-minimal-rdf-mapping-v1.1.json"), "utf8")));

// The persistent space and equipment identities are STABLE across both versions.
const SPACE_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSET_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SPACE_URI = `http://oswadt.test/id/space/${SPACE_UUID}`;

class FakeGraph {
    providerId = "fake";
    graphs = new Map<string, string>();
    healthCheck = async () => ({ ok: true, provider: "fake", queryEndpoint: "fake", durationMs: 0, errorCode: null, error: null });
    async putGraph(uri: string, payload: string) { this.graphs.set(uri, payload); }
    async query(sparql: string) {
        const graph = [...this.graphs.entries()].find(([uri]) => sparql.includes(`<${uri}>`));
        if (sparql.startsWith("SELECT")) return { results: { bindings: [{ count: { type: "literal", value: String(graph ? new Parser().parse(graph[1]).length : 0) } }] } };
        return { boolean: Boolean(graph) };
    }
    async update() {} async deleteGraph() {}
}

/** A snapshot exactly as ModelIntakeDatabase.getVersionSnapshot returns it. */
function versionSnapshot(opts: {
    id: number; versionUuid: string; spaceGuid: string; assetGuid: string;
    inventoryCodeSnapshot: string; longNameSnapshot: string; assetDisplayCode: string;
}) {
    const dir = path.join(storage, "models", "1", "versions", String(opts.id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "model.ifc"), "synthetic");
    return {
        version: { id: opts.id, version_uuid: opts.versionUuid, version_number: opts.id, model_id: 1,
            model_uuid: "11111111-1111-4111-8111-111111111111", original_filename: `v${opts.id}.ifc`,
            file_hash: String(opts.id).repeat(64).slice(0, 64), storage_key: `models/1/versions/${opts.id}/model.ifc` },
        // Same persistent space (SPACE_UUID), different version-specific inventory-code snapshot.
        spaces: [{ space_uuid: SPACE_UUID, inventory_code_snapshot: opts.inventoryCodeSnapshot,
            long_name_snapshot: opts.longNameSnapshot, ifc_guid: opts.spaceGuid }],
        // Same persistent equipment, located in the same persistent space (space_uuid).
        assets: [{ asset_uuid: ASSET_UUID, asset_code: "EQP-1", serial_number: "SYN-1",
            ifc_guid: opts.assetGuid, type_snapshot: "IfcFurnishingElement", space_id: 1,
            space_uuid: SPACE_UUID, space_inventory_code_snapshot: opts.assetDisplayCode }],
    };
}

class FakeDb {
    records = new Map<number, any>();
    snapshots = new Map<number, any>();
    snapshotReads: number[] = [];
    async getVersionSnapshot(id: number) { this.snapshotReads.push(id); return this.snapshots.get(id) ?? null; }
    async getMaterialisationByVersion(id: number) { return this.records.get(id) ?? null; }
    async createMaterialisation(input: any) {
        const record = { id: input.modelVersionId, ...input, materialisation_uuid: input.materialisationUuid,
            named_graph_uri: input.namedGraphUri, mapping_version: input.mappingVersion, status: "materialising",
            started_at: "2026-08-06T12:00:00.000Z" };
        this.records.set(input.modelVersionId, record); return record;
    }
    async markGraphWritten(id: number, counts: any) { Object.assign(this.records.get(id), { status: "graph_written", ...counts, triple_count: counts.tripleCount, turtle_sha256: counts.turtleSha256 }); }
    async markVerified(id: number) { this.records.get(id).status = "completed"; }
    async markFailed(id: number, code: string, message: string) { this.records.get(id).status = "failed_retryable"; }
}

const mappingSelection = { artifactId: 7, artifactUuid: "55555555-5555-4555-8555-555555555555",
    sha256: "b".repeat(64), version: "1.1.0", familyKey: "oswadt-ifc4-minimal-rdf-mapping", profile: mapping };
// Change C: the authoritative path resolves the mapping BY PINNED ARTIFACT ID.
const mappings: any = { resolveActive: async () => mappingSelection, resolveByArtifactId: async () => mappingSelection };
const context: any = {
    ids: { artifactId: 101, familyKey: "oswadt-ifc4-model-requirements", semanticVersion: "1.1.0", sha256: "a".repeat(64) },
    mapping: { artifactId: 7, familyKey: "oswadt-ifc4-minimal-rdf-mapping", semanticVersion: "1.1.0", sha256: "b".repeat(64) },
    shapes: { artifactId: 9, familyKey: "oswadt-model-rdf-structural-shapes", semanticVersion: "1.1.0", sha256: "d".repeat(64),
        namedGraphUri: "http://oswadt.test/id/graph/shapes/structural/55555555-5555-4555-8555-555555555559" },
};
const ids: any = { artifactId: null, artifactUuid: "44444444-4444-4444-8444-444444444444", familyKey: "temporary",
    version: "1.1.0", sha256: "a".repeat(64), source: "temporary_uploaded_profile" };
const extracted = (spaceGuid: string, assetGuid: string) => ({ schema: "IFC4X3_ADD2", uncontainedProxies: [],
    inventoryData: { [spaceGuid]: { storeyName: "Level 1", elements: [{ guid: assetGuid, psets: {} }] } } });

function build(idBase: number) {
    const id1 = idBase + 1;
    const id2 = idBase + 2;
    const db = new FakeDb();
    // V1: the space is named T-101; equipment E is located in it.
    db.snapshots.set(id1, versionSnapshot({ id: id1, versionUuid: `66666666-6666-4666-8666-${String(id1).padStart(12, "0")}`,
        spaceGuid: `space-${id1}`, assetGuid: `asset-${id1}`, inventoryCodeSnapshot: "T-101",
        longNameSnapshot: "Laboratory 101", assetDisplayCode: "T-101" }));
    // V2: SAME persistent space (SPACE_UUID) renamed to T-101-NEW with a changed LongName; same equipment.
    db.snapshots.set(id2, versionSnapshot({ id: id2, versionUuid: `66666666-6666-4666-8666-${String(id2).padStart(12, "0")}`,
        spaceGuid: `space-${id2}`, assetGuid: `asset-${id2}`, inventoryCodeSnapshot: "T-101-NEW",
        longNameSnapshot: "Renamed Laboratory 101", assetDisplayCode: "T-101-NEW" }));
    const graph = new FakeGraph();
    let n = 0;
    const service = new SemanticMaterialisationService(db as any, mappings, () => graph as any,
        () => new Date("2026-08-06T12:00:00.000Z"), () => `77777777-7777-4777-8777-${String(idBase * 100 + ++n).padStart(12, "0")}`);
    return { db, graph, service, id1, id2 };
}

test("V1 rematerialisation uses the V1 snapshot code and never leaks the renamed current code", async () => {
    const { graph, service, id1 } = build(100);
    const v1: any = await service.materialise({ versionId: id1, extractedModel: extracted(`space-${id1}`, `asset-${id1}`), ids, context });
    const turtle = graph.graphs.get(v1.namedGraphUri)!;
    assert.match(turtle, /inventoryCode "T-101"/, "V1 space carries its snapshot inventory code");
    assert.doesNotMatch(turtle, /T-101-NEW/, "the renamed current code must never leak into the V1 graph");
    assert.match(turtle, /longName "Laboratory 101"/, "V1 longName is the V1 snapshot");
    assert.match(turtle, new RegExp(`containedInSpace <${SPACE_URI}>`), "equipment is located in the persistent space URI");
});

test("V2 materialisation carries the new code and the SAME persistent space URI and location edge", async () => {
    const { graph, service, id2 } = build(200);
    const v2: any = await service.materialise({ versionId: id2, extractedModel: extracted(`space-${id2}`, `asset-${id2}`), ids, context });
    const turtle = graph.graphs.get(v2.namedGraphUri)!;
    assert.match(turtle, /inventoryCode "T-101-NEW"/, "V2 space carries its new snapshot code");
    assert.match(turtle, new RegExp(`<${SPACE_URI}>`), "the persistent space URI is identical across versions");
    assert.match(turtle, new RegExp(`containedInSpace <${SPACE_URI}>`), "the location edge still exists in V2");
    assert.match(turtle, /longName "Renamed Laboratory 101"/, "V2 longName is the V2 snapshot");
});

test("both versions materialise independently: V1 graph is unchanged by V2 and snapshot rows are never updated", async () => {
    const { db, graph, service, id1, id2 } = build(300);
    const v1: any = await service.materialise({ versionId: id1, extractedModel: extracted(`space-${id1}`, `asset-${id1}`), ids, context });
    const v1TurtleBefore = graph.graphs.get(v1.namedGraphUri);
    const v2: any = await service.materialise({ versionId: id2, extractedModel: extracted(`space-${id2}`, `asset-${id2}`), ids, context });
    assert.notEqual(v1.namedGraphUri, v2.namedGraphUri);
    assert.equal(graph.graphs.get(v1.namedGraphUri), v1TurtleBefore, "the V1 historical graph is untouched by V2");
    // Persistent space continuity: both graphs reference the same persistent space URI.
    assert.match(graph.graphs.get(v1.namedGraphUri)!, new RegExp(SPACE_URI));
    assert.match(graph.graphs.get(v2.namedGraphUri)!, new RegExp(SPACE_URI));
    // The service only READS snapshots; it never issues a historical snapshot update.
    assert.ok(!("updateSnapshot" in db), "no snapshot mutation contract exists on the materialisation DB port");
});

test("the location edge is resolved by the persistent space URI, not by inventory-code equality", async () => {
    const db = new FakeDb();
    // Deliberately make the asset's DISPLAY code disagree with the space's inventory code.
    // If the edge depended on code equality it would break; keyed on space_uuid it must hold.
    db.snapshots.set(409, versionSnapshot({ id: 409, versionUuid: "66666666-6666-4666-8666-000000000409",
        spaceGuid: "space-409", assetGuid: "asset-409", inventoryCodeSnapshot: "T-101",
        longNameSnapshot: "Laboratory 101", assetDisplayCode: "COMPLETELY-DIFFERENT" }));
    const graph = new FakeGraph();
    const service = new SemanticMaterialisationService(db as any, mappings, () => graph as any,
        () => new Date("2026-08-06T12:00:00.000Z"), () => "77777777-7777-4777-8777-000000000409");
    const v: any = await service.materialise({ versionId: 409, extractedModel: extracted("space-409", "asset-409"), ids, context });
    const turtle = graph.graphs.get(v.namedGraphUri)!;
    assert.match(turtle, /inventoryCode "T-101"/);
    assert.match(turtle, new RegExp(`containedInSpace <${SPACE_URI}>`),
        "the edge resolves via the persistent space URI even when display codes differ");
});

after(() => fs.rmSync(storage, { recursive: true, force: true }));
