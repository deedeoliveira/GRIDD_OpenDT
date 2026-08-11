/**
 * Change C (F + G): Intake-A / atomic-activation / Intake-B interleaving.
 *
 * Drives the REAL `SemanticMaterialisationService.materialise()` (the authoritative
 * persistence path), the REAL pinned resolvers via a context built by the REAL
 * `buildSemanticExecutionContext`, and the REAL `Ifc4x3TripletActivationService` against
 * the shared FakeSemanticArtifactDatabase — the same Level-2 interleaving style as
 * tests/semantic/ifc4x3TripletActivation.mysqlTransaction.test.ts, but at the intake
 * boundary rather than the activation boundary.
 */
import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Parser } from "n3";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oswadt-intakectx-"));
const artifactRoot = path.join(sandbox, "semantic", "artifacts");
const sandboxCwd = path.join(sandbox, "back");
const storage = path.join(sandbox, "storage");
fs.mkdirSync(artifactRoot, { recursive: true });
fs.mkdirSync(sandboxCwd, { recursive: true });
fs.mkdirSync(storage, { recursive: true });

const realMappingProfile = JSON.parse(fs.readFileSync(
    path.resolve(process.cwd(), "../semantic/artifacts/runtime/oswadt-ifc4-minimal-rdf-mapping/1.1.0/oswadt-ifc4-minimal-rdf-mapping-v1.1.json"), "utf8"));

process.env.OSWADT_STORAGE_ROOT = storage;
process.env.IFC_RDF_MATERIALISATION_ENABLED = "true";
process.env.IFC_RDF_MATERIALISATION_MODE = "required";
process.env.IFC_RDF_MAPPING_FAMILY_KEY = "oswadt-ifc4-minimal-rdf-mapping";
process.env.SEMANTIC_ARTIFACT_ROOT = artifactRoot;
process.env.GRAPH_PROVIDER = "fuseki";
process.env.GRAPH_QUERY_ENDPOINT = "http://localhost:3030/test/query";
process.env.GRAPH_UPDATE_ENDPOINT = "http://localhost:3030/test/update";
process.env.GRAPH_DATA_ENDPOINT = "http://localhost:3030/test/data";
process.env.GRAPH_BASE_URI = "http://oswadt.test/id";
process.env.SHACL_VALIDATION_ENABLED = "true";
process.env.SHACL_VALIDATION_MODE = "required";
process.env.TEMPORARY_SHAPES_UPLOAD_ENABLED = "false";
process.chdir(sandboxCwd);

const { SemanticMaterialisationService } = await import("../../modelIntake/semanticMaterialisationService.ts");
const { MappingProfileService } = await import("../../modelIntake/mappingProfileService.ts");
const { ShapeSetService } = await import("../../semanticValidation/shapeSetService.ts");
const { IdsProfileResolver } = await import("../../requirements/idsProfileResolver.ts");
const { buildSemanticExecutionContext, SemanticContextError } = await import("../../modelIntake/semanticExecutionContext.ts");
const { Ifc4x3TripletActivationService } = await import("../../semantic/ifc4x3TripletActivationService.ts");
const { structuralShapesGraphUri } = await import("../../graph/namedGraphs.ts");
const { FakeSemanticArtifactDatabase } = await import("../helpers/fakeSemanticArtifacts.ts");

const IDS = "oswadt-ifc4-model-requirements";
const MAPPING = "oswadt-ifc4-minimal-rdf-mapping";
const SHAPES = "oswadt-model-rdf-structural-shapes";
const SOURCE = "1.0.0";
const TARGET = "1.1.0";

const SHAPES_TURTLE = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix bot: <https://w3id.org/bot#> .
<https://deedeoliveira.github.io/GRIDD_OpenDT/ontology/model-intake-v1#SpaceShape>
    a sh:NodeShape ; sh:targetClass bot:Space .
`;

function payloadFor(familyKey: string, version: string): Buffer {
    if (familyKey === MAPPING) return Buffer.from(JSON.stringify({ ...realMappingProfile, version }), "utf8");
    if (familyKey === SHAPES) return Buffer.from(`${SHAPES_TURTLE}# revision ${version}\n`, "utf8");
    return Buffer.from(`<ids version="${version}"/>`, "utf8");
}

/** Seeds all three families with an ACTIVE 1.0.0 source and a verified-but-inactive 1.1.0 target. */
async function seedRegistry() {
    const db = new FakeSemanticArtifactDatabase();
    let seq = 0;
    const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
    const ids: Record<string, Record<string, any>> = {};

    for (const familyKey of [IDS, MAPPING, SHAPES]) {
        const graphBacked = familyKey === SHAPES;
        const family = await db.ensureFamily({
            familyUuid: uuid(),
            artifactType: graphBacked ? "shacl_shapes" : familyKey === MAPPING ? "ifc_rdf_mapping" : "ids_profile",
            familyKey, name: familyKey,
            semanticUri: `https://example.test/${familyKey}`,
            privacyPolicy: "public_research_artifact",
        });
        ids[familyKey] = {};
        for (const version of [SOURCE, TARGET]) {
            const bytes = payloadFor(familyKey, version);
            const relative = `runtime/${familyKey}/${version}/${familyKey}-${version}.dat`;
            const absolute = path.join(artifactRoot, relative);
            fs.mkdirSync(path.dirname(absolute), { recursive: true });
            fs.writeFileSync(absolute, bytes);
            const artifactUuid = uuid();
            const artifact = await db.ensureArtifact({
                artifactUuid, familyId: Number(family.id), semanticVersion: version,
                sourceFilename: path.basename(relative), repositoryRelativePath: relative,
                byteSize: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
                mediaType: graphBacked ? "text/turtle" : "application/json", serialization: graphBacked ? "turtle" : "json",
                semanticUri: `https://example.test/${familyKey}/${version}`,
                storageMode: graphBacked ? "graph_backed" : "file_executed",
                namedGraphUri: graphBacked ? structuralShapesGraphUri("http://oswadt.test/id", artifactUuid) : null,
                sourcePackageName: "oswadt-change-c", sourcePackageVersion: version, sourceReleaseStatus: "stable",
                privacyClassification: "public_research_artifact", predecessorArtifactId: null,
            });
            const operation = await db.ensureOperation({
                operationUuid: uuid(), idempotencyKey: `seed:${familyKey}:${version}`,
                artifactId: Number(artifact.id), operationType: version === SOURCE ? "load_and_activate" : "load_without_activation",
                payloadHash: `hash:${familyKey}:${version}`,
                previousArtifactId: family.current_artifact_id === null ? null : Number(family.current_artifact_id),
            });
            if (graphBacked) {
                artifact.validation_status = "graph_verified";
                artifact.lifecycle_status = "validated";
                await db.setOperationStatus(operation.operation_uuid, "graph_written");
            } else {
                await db.markFileVerified(operation.operation_uuid, Number(artifact.id), { kind: "seed", accepted: true });
            }
            if (version === SOURCE) {
                await db.activateArtifact({
                    operationUuid: operation.operation_uuid, familyId: Number(family.id),
                    artifactId: Number(artifact.id), expectedCurrentArtifactId: null,
                });
            }
            ids[familyKey]![version] = artifact;
        }
    }
    return { db, artifacts: ids };
}

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

class FakeMaterialisationDb {
    records = new Map<number, any>();
    snapshots = new Map<number, any>();
    async getVersionSnapshot(id: number) { return this.snapshots.get(id) ?? null; }
    async getMaterialisationByVersion(id: number) { return this.records.get(id) ?? null; }
    async createMaterialisation(input: any) {
        const record = { id: input.modelVersionId, ...input, materialisation_uuid: input.materialisationUuid,
            named_graph_uri: input.namedGraphUri, mapping_version: input.mappingVersion,
            mapping_artifact_id: input.mappingArtifactId, ids_profile_artifact_id: input.idsProfileArtifactId,
            status: "materialising", started_at: "2026-07-20T12:00:00.000Z" };
        this.records.set(input.modelVersionId, record);
        return record;
    }
    async markGraphWritten(id: number, counts: any) { Object.assign(this.records.get(id), { status: "graph_written", ...counts, triple_count: counts.tripleCount, turtle_sha256: counts.turtleSha256 }); }
    async markVerified(id: number) { this.records.get(id).status = "completed"; }
    async markFailed(id: number) { this.records.get(id).status = "failed_retryable"; }
}

/** Real ShapeSetService behind the SemanticValidationService seam, plus a recorded report. */
function validationSeam(db: any, persistedShapesArtifactIds: number[]) {
    const shapes = new ShapeSetService(db, {
        inspectShapes: async () => ({ constraints: [], executorName: "pySHACL", executorVersion: "0.40.0" }),
        validate: async () => ({}),
    } as any);
    return {
        async inspectGoverned() { throw new Error("the authoritative path must never resolve active shapes"); },
        async inspectPinned(selection: any) { return shapes.resolveByArtifactId(selection); },
        async execute(_data: string, selection: any) {
            return { runUuid: "99999999-9999-4999-8999-999999999999", conforms: true, resultCount: 0, results: [],
                shapesSource: "governed_active_shapes", shapesArtifactId: selection.artifactId,
                shapesFamilyKey: selection.familyKey, shapesVersion: selection.version,
                reportTurtle: "@prefix sh: <http://www.w3.org/ns/shacl#> . [] a sh:ValidationReport ." };
        },
        async persistModelReport(report: any) {
            // Stands in for semantic_validation_runs.shapes_artifact_id.
            persistedShapesArtifactIds.push(Number(report.shapesArtifactId));
            return { ...report, reportGraphUri: `http://oswadt.test/id/graph/validation/report/${report.runUuid}` };
        },
    };
}

function snapshot(id: number) {
    const dir = path.join(storage, "models", "1", "versions", String(id));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "model.ifc"), "synthetic");
    return { version: { id, version_uuid: `66666666-6666-4666-8666-${String(id).padStart(12, "0")}`, version_number: id,
        model_id: 1, model_uuid: "11111111-1111-4111-8111-111111111111", original_filename: `v${id}.ifc`,
        file_hash: String(id).repeat(64).slice(0, 64), storage_key: `models/1/versions/${id}/model.ifc` },
      spaces: [{ space_uuid: "22222222-2222-4222-8222-222222222222", inventory_code_snapshot: "R-101", long_name_snapshot: "Room", ifc_guid: `space-${id}` }],
      assets: [] };
}

const extractedModel: any = { schema: "IFC4X3_ADD2", uncontainedProxies: [], inventoryData: {} };

/** One controlled intake: capture the context, resolve the pinned IDS, materialise. */
async function runIntake(db: any, versionId: number, persistedShapesArtifactIds: number[]) {
    const context = await buildSemanticExecutionContext(db);
    const profile = await new IdsProfileResolver(db, artifactRoot).resolveByArtifactId(context.ids);
    const materialisationDb = new FakeMaterialisationDb();
    materialisationDb.snapshots.set(versionId, snapshot(versionId));
    const service = new SemanticMaterialisationService(
        materialisationDb as any, new MappingProfileService(db) as any, () => new FakeGraph() as any,
        () => new Date("2026-07-20T12:00:00.000Z"), () => `77777777-7777-4777-8777-${String(versionId).padStart(12, "0")}`,
        validationSeam(db, persistedShapesArtifactIds) as any);
    const result: any = await service.materialise({
        versionId, extractedModel,
        ids: { ...profile, source: "governed_active_profile", originalFilename: "governed.ids", executorName: "IfcTester",
            executorVersion: "0.8.4", specificationCount: 1, requirements: [] } as any,
        context,
    });
    return { context, result, record: materialisationDb.records.get(versionId) };
}

test("intake A pinned to 1.0.0 completes on 1.0.0 even when an atomic 1.1.0 activation interleaves, and intake B then uses only 1.1.0", async () => {
    const { db, artifacts } = await seedRegistry();
    const persistedShapes: number[] = [];

    // ---- Intake A: capture the context while the full 1.0.0 source triplet is current.
    const contextA = await buildSemanticExecutionContext(db);
    assert.deepEqual(
        [contextA.ids.semanticVersion, contextA.mapping.semanticVersion, contextA.shapes.semanticVersion],
        [SOURCE, SOURCE, SOURCE]);

    // ---- Interleave a Change-B-style ATOMIC activation of the full 1.1.0 target triplet.
    const activation = await new Ifc4x3TripletActivationService(db).activateGovernedTargetSet();
    assert.equal(activation.status, "activated");
    for (const familyKey of [IDS, MAPPING, SHAPES]) {
        const family = await db.findFamilyByKey(familyKey);
        assert.equal(Number(family!.current_artifact_id), Number(artifacts[familyKey]![TARGET].id), `${familyKey} now points at 1.1.0`);
    }

    // ---- Resume intake A: every authoritative resolution must still land on 1.0.0.
    const profileA = await new IdsProfileResolver(db, artifactRoot).resolveByArtifactId(contextA.ids);
    const materialisationDb = new FakeMaterialisationDb();
    materialisationDb.snapshots.set(1, snapshot(1));
    const serviceA = new SemanticMaterialisationService(
        materialisationDb as any, new MappingProfileService(db) as any, () => new FakeGraph() as any,
        () => new Date("2026-07-20T12:00:00.000Z"), () => "77777777-7777-4777-8777-000000000001",
        validationSeam(db, persistedShapes) as any);
    const resultA: any = await serviceA.materialise({
        versionId: 1, extractedModel,
        ids: { ...profileA, source: "governed_active_profile", originalFilename: "governed.ids", executorName: "IfcTester",
            executorVersion: "0.8.4", specificationCount: 1, requirements: [] } as any,
        context: contextA,
    });
    assert.equal(resultA.status, "completed");

    const recordA = materialisationDb.records.get(1);
    const sourceIds = {
        ids: Number(artifacts[IDS]![SOURCE].id),
        mapping: Number(artifacts[MAPPING]![SOURCE].id),
        shapes: Number(artifacts[SHAPES]![SOURCE].id),
    };
    assert.equal(Number(recordA.mapping_artifact_id), sourceIds.mapping, "model_version_semantic_materialisations.mapping_artifact_id is 1.0.0");
    assert.equal(Number(recordA.ids_profile_artifact_id), sourceIds.ids, "model_version_semantic_materialisations.ids_profile_artifact_id is 1.0.0");
    assert.equal(Number(profileA.artifactId), sourceIds.ids, "the IDS profileOverride is the 1.0.0 revision");
    assert.deepEqual(persistedShapes, [sourceIds.shapes], "semantic_validation_runs.shapes_artifact_id is 1.0.0");

    const usedByA = new Set([Number(recordA.mapping_artifact_id), Number(recordA.ids_profile_artifact_id), persistedShapes[0]!]);
    const targetIdSet = new Set([Number(artifacts[IDS]![TARGET].id), Number(artifacts[MAPPING]![TARGET].id), Number(artifacts[SHAPES]![TARGET].id)]);
    assert.equal([...usedByA].some((id) => targetIdSet.has(id)), false, "intake A must never persist a 1.1.0 artifact id");

    // ---- Intake B afterwards: must capture the target set and persist only 1.1.0 ids.
    const persistedShapesB: number[] = [];
    const intakeB = await runIntake(db, 2, persistedShapesB);
    assert.deepEqual(
        [intakeB.context.ids.semanticVersion, intakeB.context.mapping.semanticVersion, intakeB.context.shapes.semanticVersion],
        [TARGET, TARGET, TARGET]);
    assert.equal(intakeB.result.status, "completed");
    assert.equal(Number(intakeB.record.mapping_artifact_id), Number(artifacts[MAPPING]![TARGET].id));
    assert.equal(Number(intakeB.record.ids_profile_artifact_id), Number(artifacts[IDS]![TARGET].id));
    assert.deepEqual(persistedShapesB, [Number(artifacts[SHAPES]![TARGET].id)]);

    const sourceIdSet = new Set(Object.values(sourceIds));
    const usedByB = [Number(intakeB.record.mapping_artifact_id), Number(intakeB.record.ids_profile_artifact_id), persistedShapesB[0]!];
    assert.equal(usedByB.some((id) => sourceIdSet.has(id)), false, "intake B must never persist a 1.0.0 artifact id");
});

test("a stable committed INDEPENDENTLY VERSIONED current set is captured and executed as-is", async () => {
    const { db, artifacts } = await seedRegistry();
    // The BIM manager advanced ONLY the mapping family to 1.1.0 and left IDS/shapes at
    // 1.0.0. Under the frozen governance model that is a legitimate governed combination:
    // runtime must not second-guess it from version numbers, only capture it coherently.
    const mappingFamily = await db.findFamilyByKey(MAPPING);
    artifacts[MAPPING]![SOURCE].lifecycle_status = "superseded";
    artifacts[MAPPING]![TARGET].lifecycle_status = "active";
    mappingFamily!.current_artifact_id = Number(artifacts[MAPPING]![TARGET].id);

    const context = await buildSemanticExecutionContext(db);
    assert.deepEqual(
        [context.ids.semanticVersion, context.mapping.semanticVersion, context.shapes.semanticVersion],
        [SOURCE, TARGET, SOURCE]);

    // ...and the whole authoritative attempt executes and persists exactly that mix.
    const persistedShapes: number[] = [];
    const intake = await runIntake(db, 3, persistedShapes);
    assert.equal(intake.result.status, "completed");
    assert.equal(Number(intake.record.mapping_artifact_id), Number(artifacts[MAPPING]![TARGET].id));
    assert.equal(Number(intake.record.ids_profile_artifact_id), Number(artifacts[IDS]![SOURCE].id));
    assert.deepEqual(persistedShapes, [Number(artifacts[SHAPES]![SOURCE].id)]);
});
