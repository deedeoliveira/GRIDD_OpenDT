import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Parser } from "n3";

const storage = fs.mkdtempSync(path.join(os.tmpdir(), "oswadt-materialisation-"));
process.env.OSWADT_STORAGE_ROOT = storage;
process.env.IFC_RDF_MATERIALISATION_ENABLED = "true";
process.env.IFC_RDF_MATERIALISATION_MODE = "required";
process.env.IFC_RDF_MAPPING_FAMILY_KEY = "oswadt-ifc4-minimal-rdf-mapping";
process.env.GRAPH_PROVIDER = "fuseki";
process.env.GRAPH_QUERY_ENDPOINT = "http://localhost:3030/test/query";
process.env.GRAPH_UPDATE_ENDPOINT = "http://localhost:3030/test/update";
process.env.GRAPH_DATA_ENDPOINT = "http://localhost:3030/test/data";
process.env.GRAPH_BASE_URI = "http://oswadt.test/id";

const { SemanticMaterialisationService } = await import("../../modelIntake/semanticMaterialisationService.ts");
const { validateMappingProfile } = await import("../../modelIntake/mappingProfileService.ts");
const mapping = validateMappingProfile(JSON.parse(fs.readFileSync(path.resolve("../semantic/artifacts/runtime/oswadt-ifc4-minimal-rdf-mapping/1.0.0/oswadt-ifc4-minimal-rdf-mapping-v1.json"), "utf8")));

class FakeGraph {
    providerId = "fake";
    graphs = new Map<string, string>();
    puts = 0;
    failPut = false;
    healthCheck = async () => ({ ok: true, provider: "fake", queryEndpoint: "fake", durationMs: 0, errorCode: null, error: null });
    async putGraph(uri: string, payload: string) { if (this.failPut) throw new Error("synthetic graph failure"); this.puts++; this.graphs.set(uri, payload); }
    async query(sparql: string) {
        const graph = [...this.graphs.entries()].find(([uri]) => sparql.includes(`<${uri}>`));
        if (sparql.startsWith("SELECT")) return { results: { bindings: [{ count: { type: "literal", value: String(graph ? new Parser().parse(graph[1]).length : 0) } }] } };
        return { boolean: Boolean(graph) };
    }
    async update() {} async deleteGraph() {}
}

class FakeDb {
    records = new Map<number, any>();
    failed: any[] = [];
    snapshots = new Map<number, any>();
    async getVersionSnapshot(id: number) { return this.snapshots.get(id) ?? null; }
    async getMaterialisationByVersion(id: number) { return this.records.get(id) ?? null; }
    async createMaterialisation(input: any) {
        const record = { id: input.modelVersionId, ...input, materialisation_uuid: input.materialisationUuid,
            named_graph_uri: input.namedGraphUri, mapping_version: input.mappingVersion, status: "materialising", started_at: "2026-07-20T12:00:00.000Z" };
        this.records.set(input.modelVersionId, record); return record;
    }
    async markGraphWritten(id: number, counts: any) { Object.assign(this.records.get(id), { status: "graph_written", ...counts,
        triple_count: counts.tripleCount, turtle_sha256: counts.turtleSha256 }); }
    async markVerified(id: number) { this.records.get(id).status = "completed"; }
    async markFailed(id: number, code: string, message: string) { this.records.get(id).status = "failed_retryable"; this.failed.push({ id, code, message }); }
}

function snapshot(id: number, versionUuid: string, spaceGuid: string, assetGuid: string) {
    const dir = path.join(storage, "models", "1", "versions", String(id)); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "model.ifc"), "synthetic");
    return { version: { id, version_uuid: versionUuid, version_number: id, model_id: 1, model_uuid: "11111111-1111-4111-8111-111111111111",
        original_filename: `v${id}.ifc`, file_hash: String(id).repeat(64).slice(0, 64), storage_key: `models/1/versions/${id}/model.ifc` },
      spaces: [{ space_uuid: "22222222-2222-4222-8222-222222222222", inventory_code: "R-101", ifc_guid: spaceGuid, name_snapshot: "Room" }],
      assets: [{ asset_uuid: "33333333-3333-4333-8333-333333333333", asset_code: "EQP-DEMO-001", serial_number: "SYN-001",
        ifc_guid: assetGuid, type_snapshot: "IfcFurnishingElement", space_reference: "R-101" }] };
}

const extracted = (spaceGuid: string, assetGuid: string, storey: string) => ({ schema: "IFC4", uncontainedProxies: [], inventoryData: {
    [spaceGuid]: { storeyName: storey, elements: [{ guid: assetGuid, psets: { Pset_ManufacturerOccurrence: { Manufacturer: "Synthetic" } } }] },
} });
const ids: any = { artifactId: null, artifactUuid: "44444444-4444-4444-8444-444444444444", familyKey: "temporary", version: "1.0.0",
    sha256: "a".repeat(64), absolutePath: "not-returned", source: "temporary_uploaded_profile", originalFilename: "selected.ids",
    executorName: "IfcTester", executorVersion: "0.8.4", specificationCount: 1, requirements: [] };
const mappings: any = { resolveActive: async () => ({ artifactId: 7, artifactUuid: "55555555-5555-4555-8555-555555555555",
    sha256: "b".repeat(64), version: "1.0.0", familyKey: "oswadt-ifc4-minimal-rdf-mapping", profile: mapping }) };

function validationReport(conforms: boolean) {
    return { runUuid: "99999999-9999-4999-8999-999999999999", correlationId: "99999999-9999-4999-8999-999999999999",
        validationKind: "model_rdf_structural", status: "completed", conforms, resultCount: conforms ? 0 : 1,
        results: conforms ? [] : [{ focusNode: "urn:model", resultPath: "urn:required", value: null,
            sourceShape: "urn:shape", sourceConstraintComponent: "http://www.w3.org/ns/shacl#MinCountConstraintComponent",
            severity: "http://www.w3.org/ns/shacl#Violation", message: "Synthetic required value is absent." }],
        constraints: [], dataGraphSha256: "c".repeat(64), shapesGraphSha256: "d".repeat(64),
        shapesSource: "governed_active_shapes", shapesArtifactId: 9, shapesFamilyKey: "oswadt-model-rdf-structural-shapes",
        shapesVersion: "1.0.0", shapesFilename: "oswadt-model-rdf-structural-shapes-v1.ttl", executorName: "pySHACL",
        executorVersion: "0.40.0", inferenceMode: "none", advanced: true, metaShacl: true,
        startedAt: "2026-07-20T12:00:00.000Z", completedAt: "2026-07-20T12:00:01.000Z",
        reportTurtle: "@prefix sh: <http://www.w3.org/ns/shacl#> . [] a sh:ValidationReport .",
        reportSha256: "e".repeat(64), reportGraphUri: null, modelVersionId: null, materialisationId: null };
}

class FakeValidation {
    persisted = 0;
    constructor(private readonly conforms: boolean) {}
    async inspectGoverned() { return { source: "governed_active_shapes", artifactId: 9 }; }
    async execute() { return validationReport(this.conforms); }
    async persistModelReport(report: any, _graph: string, versionId: number, materialisationId: number) {
        this.persisted++; return { ...report, modelVersionId: versionId, materialisationId,
            reportGraphUri: `http://oswadt.test/id/graph/validation/report/${report.runUuid}` };
    }
}

test("required materialisation writes and remotely verifies one immutable graph before completion; retry does not overwrite it", async () => {
    const db = new FakeDb(); const graph = new FakeGraph();
    db.snapshots.set(1, snapshot(1, "66666666-6666-4666-8666-666666666661", "space-v1", "asset-v1"));
    const service = new SemanticMaterialisationService(db as any, mappings, () => graph as any,
        () => new Date("2026-07-20T12:00:00.000Z"), () => "77777777-7777-4777-8777-777777777777");
    const result: any = await service.materialise({ versionId: 1, extractedModel: extracted("space-v1", "asset-v1", "Level 1"), ids });
    assert.equal(result.status, "completed"); assert.equal(graph.puts, 1); assert.equal(db.records.get(1).status, "completed");
    assert.match(result.namedGraphUri, /graph\/model-version\/66666666/);
    assert.equal(new Parser().parse(graph.graphs.get(result.namedGraphUri)!).length, result.tripleCount);
    await service.materialise({ versionId: 1, extractedModel: extracted("space-v1", "asset-v1", "Level 1"), ids });
    assert.equal(graph.puts, 1, "completed immutable graph is never overwritten on retry");
});

test("V2 receives a distinct graph while V1 remains unchanged and persistent identities remain the same", async () => {
    const db = new FakeDb(); const graph = new FakeGraph();
    db.snapshots.set(11, snapshot(11, "66666666-6666-4666-8666-666666666671", "space-v1", "asset-v1"));
    db.snapshots.set(12, snapshot(12, "66666666-6666-4666-8666-666666666672", "space-v2", "asset-v2"));
    let n = 0; const service = new SemanticMaterialisationService(db as any, mappings, () => graph as any,
        () => new Date("2026-07-20T12:00:00.000Z"), () => `77777777-7777-4777-8777-${String(++n).padStart(12, "0")}`);
    const v1: any = await service.materialise({ versionId: 11, extractedModel: extracted("space-v1", "asset-v1", "Level 1"), ids });
    const originalV1 = graph.graphs.get(v1.namedGraphUri);
    const v2: any = await service.materialise({ versionId: 12, extractedModel: extracted("space-v2", "asset-v2", "Level 2"), ids });
    assert.notEqual(v1.namedGraphUri, v2.namedGraphUri); assert.equal(graph.graphs.get(v1.namedGraphUri), originalV1);
    assert.match(graph.graphs.get(v1.namedGraphUri)!, /22222222-2222-4222-8222-222222222222/);
    assert.match(graph.graphs.get(v2.namedGraphUri)!, /22222222-2222-4222-8222-222222222222/);
    assert.match(graph.graphs.get(v1.namedGraphUri)!, /space-v1/); assert.match(graph.graphs.get(v2.namedGraphUri)!, /space-v2/);
});

test("graph failure is recorded retryable and required mode does not report completion", async () => {
    const db = new FakeDb(); const graph = new FakeGraph(); graph.failPut = true;
    db.snapshots.set(3, snapshot(3, "66666666-6666-4666-8666-666666666663", "space-v3", "asset-v3"));
    const service = new SemanticMaterialisationService(db as any, mappings, () => graph as any);
    await assert.rejects(service.materialise({ versionId: 3, extractedModel: extracted("space-v3", "asset-v3", "Level 3"), ids }), /synthetic graph failure/);
    assert.equal(db.records.get(3).status, "failed_retryable"); assert.equal(db.failed.length, 1);
});

test("disabled mode performs no graph or SQL materialisation operation", async () => {
    process.env.IFC_RDF_MATERIALISATION_ENABLED = "false"; process.env.IFC_RDF_MATERIALISATION_MODE = "disabled";
    const db = new FakeDb(); const graph = new FakeGraph();
    const result: any = await new SemanticMaterialisationService(db as any, mappings, () => graph as any).materialise({ versionId: 1, extractedModel: extracted("s", "a", "L"), ids });
    assert.equal(result.status, "disabled"); assert.equal(graph.puts, 0); assert.equal(db.records.size, 0);
    process.env.IFC_RDF_MATERIALISATION_ENABLED = "true"; process.env.IFC_RDF_MATERIALISATION_MODE = "required";
});

test("required SHACL non-conformance prevents graph writing and therefore cannot activate an incomplete version", async () => {
    process.env.SHACL_VALIDATION_ENABLED = "true"; process.env.SHACL_VALIDATION_MODE = "required";
    const db = new FakeDb(); const graph = new FakeGraph(); const validation = new FakeValidation(false);
    db.snapshots.set(21, snapshot(21, "66666666-6666-4666-8666-666666666681", "space-v21", "asset-v21"));
    const service = new SemanticMaterialisationService(db as any, mappings, () => graph as any,
        () => new Date("2026-07-20T12:00:00.000Z"), () => "77777777-7777-4777-8777-777777777721", validation as any);
    await assert.rejects(service.materialise({ versionId: 21, extractedModel: extracted("space-v21", "asset-v21", "Level 1"), ids }),
        /does not conform/);
    assert.equal(graph.puts, 0);
    assert.equal(validation.persisted, 0);
    process.env.SHACL_VALIDATION_ENABLED = "false"; process.env.SHACL_VALIDATION_MODE = "disabled";
});

test("report_only records a governed non-conformant report but does not block verified graph materialisation", async () => {
    process.env.SHACL_VALIDATION_ENABLED = "true"; process.env.SHACL_VALIDATION_MODE = "report_only";
    const db = new FakeDb(); const graph = new FakeGraph(); const validation = new FakeValidation(false);
    db.snapshots.set(22, snapshot(22, "66666666-6666-4666-8666-666666666682", "space-v22", "asset-v22"));
    const service = new SemanticMaterialisationService(db as any, mappings, () => graph as any,
        () => new Date("2026-07-20T12:00:00.000Z"), () => "77777777-7777-4777-8777-777777777722", validation as any);
    const result: any = await service.materialise({ versionId: 22, extractedModel: extracted("space-v22", "asset-v22", "Level 1"), ids });
    assert.equal(result.status, "completed"); assert.equal(result.shaclValidation.conforms, false);
    assert.equal(graph.puts, 1); assert.equal(validation.persisted, 1);
    process.env.SHACL_VALIDATION_ENABLED = "false"; process.env.SHACL_VALIDATION_MODE = "disabled";
});

test("upload integration keeps disabled, best_effort, and required decisions separate and activates only after the semantic stage", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "services/modelUploadService.ts"), "utf8");
    assert.ok(source.indexOf('stage = "semantic_materialisation"') < source.indexOf('stage = "activation"'));
    assert.match(source, /if \(intakeConfig\.mode === "required"\) throw error/);
    assert.match(source, /failed_retryable/);
});

after(() => fs.rmSync(storage, { recursive: true, force: true }));
