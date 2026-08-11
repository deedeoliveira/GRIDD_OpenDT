/**
 * Change C (B, C, D, E): the pinned by-artifact-id resolvers for the IDS profile, the
 * IFC-to-RDF mapping and the governed SHACL shapes.
 *
 * Every test drives the REAL resolver classes against the shared
 * FakeSemanticArtifactDatabase and real on-disk artifact bytes in a temp artifact root.
 * No live Fuseki and no live pySHACL are involved: the shapes resolver's provider is the
 * injectable SemanticValidationProvider seam, which the resolver already exposes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.GRAPH_PROVIDER = "fuseki";
process.env.GRAPH_QUERY_ENDPOINT = "http://localhost:3030/test/query";
process.env.GRAPH_UPDATE_ENDPOINT = "http://localhost:3030/test/update";
process.env.GRAPH_DATA_ENDPOINT = "http://localhost:3030/test/data";
process.env.GRAPH_BASE_URI = "http://oswadt.test/id";
process.env.SHACL_VALIDATION_ENABLED = "true";
process.env.SHACL_VALIDATION_MODE = "required";
process.env.TEMPORARY_SHAPES_UPLOAD_ENABLED = "false";

// semanticValidationConfig derives the shapes artifact root from process.cwd() as
// `../semantic/artifacts` (production behaviour Change C must not alter), so the harness
// builds a matching disposable layout and chdirs into it. Nothing under the repository's
// real semantic/artifacts tree is read or written by these tests.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "oswadt-pinned-"));
const artifactRoot = path.join(sandbox, "semantic", "artifacts");
const sandboxCwd = path.join(sandbox, "back");
fs.mkdirSync(artifactRoot, { recursive: true });
fs.mkdirSync(sandboxCwd, { recursive: true });
const realMappingProfile = JSON.parse(fs.readFileSync(
    path.resolve(process.cwd(), "../semantic/artifacts/runtime/oswadt-ifc4-minimal-rdf-mapping/1.1.0/oswadt-ifc4-minimal-rdf-mapping-v1.1.json"), "utf8"));
process.chdir(sandboxCwd);
process.env.SEMANTIC_ARTIFACT_ROOT = artifactRoot;

const { IdsProfileResolver } = await import("../../requirements/idsProfileResolver.ts");
const { MappingProfileService } = await import("../../modelIntake/mappingProfileService.ts");
const { ShapeSetService } = await import("../../semanticValidation/shapeSetService.ts");
const { SemanticContextError } = await import("../../modelIntake/semanticExecutionContext.ts");
const { structuralShapesGraphUri } = await import("../../graph/namedGraphs.ts");
const { FakeSemanticArtifactDatabase } = await import("../helpers/fakeSemanticArtifacts.ts");
type FakeDb = InstanceType<typeof FakeSemanticArtifactDatabase>;

const IDS = "oswadt-ifc4-model-requirements";
const MAPPING = "oswadt-ifc4-minimal-rdf-mapping";
const SHAPES = "oswadt-model-rdf-structural-shapes";

const SHAPES_TURTLE = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix bot: <https://w3id.org/bot#> .
<https://deedeoliveira.github.io/GRIDD_OpenDT/ontology/model-intake-v1#SpaceShape>
    a sh:NodeShape ; sh:targetClass bot:Space .
`;

function uuidSequence(): () => string {
    let value = 0;
    return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

function writeArtifactFile(familyKey: string, version: string, bytes: Buffer): string {
    const relative = path.join("runtime", familyKey, version, `${familyKey}-${version}.dat`);
    const absolute = path.join(artifactRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes);
    return relative.split(path.sep).join("/");
}

function payloadFor(familyKey: string, version: string): Buffer {
    if (familyKey === MAPPING) return Buffer.from(JSON.stringify({ ...realMappingProfile, version }), "utf8");
    // Distinct bytes per revision: the registry forbids two revisions of one family
    // sharing a payload hash, exactly as production does.
    if (familyKey === SHAPES) return Buffer.from(`${SHAPES_TURTLE}# revision ${version}\n`, "utf8");
    return Buffer.from(`<ids version="${version}"/>`, "utf8");
}

/** Registers one revision on disk + in the fake registry; optionally makes it current/active. */
async function seed(db: FakeDb, nextUuid: () => string, familyKey: string, version: string,
    options: { current?: boolean; lifecycle?: "staged" | "validated" | "active" | "superseded" | "retired" | "failed" } = {}) {
    const graphBacked = familyKey === SHAPES;
    const family = await db.ensureFamily({
        familyUuid: nextUuid(),
        artifactType: graphBacked ? "shacl_shapes" : familyKey === MAPPING ? "ifc_rdf_mapping" : "ids_profile",
        familyKey, name: familyKey,
        semanticUri: `https://example.test/${familyKey}`,
        privacyPolicy: "public_research_artifact",
    });
    const bytes = payloadFor(familyKey, version);
    const relativePath = writeArtifactFile(familyKey, version, bytes);
    const artifactUuid = nextUuid();
    const artifact = await db.ensureArtifact({
        artifactUuid, familyId: Number(family.id), semanticVersion: version,
        sourceFilename: path.basename(relativePath), repositoryRelativePath: relativePath,
        byteSize: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        mediaType: graphBacked ? "text/turtle" : "application/json", serialization: graphBacked ? "turtle" : "json",
        semanticUri: `https://example.test/${familyKey}/${version}`,
        storageMode: graphBacked ? "graph_backed" : "file_executed",
        namedGraphUri: graphBacked ? structuralShapesGraphUri("http://oswadt.test/id", artifactUuid) : null,
        sourcePackageName: "oswadt-change-c", sourcePackageVersion: version, sourceReleaseStatus: "stable",
        privacyClassification: "public_research_artifact", predecessorArtifactId: null,
    });
    artifact.validation_status = graphBacked ? "graph_verified" : "file_verified";
    artifact.lifecycle_status = options.lifecycle ?? (options.current ? "active" : "validated");
    if (options.current) family.current_artifact_id = Number(artifact.id);
    return { family, artifact };
}

function selectionOf(familyKey: string, artifact: any) {
    const base = { artifactId: Number(artifact.id), familyKey, semanticVersion: artifact.semantic_version, sha256: artifact.sha256 };
    return familyKey === SHAPES ? { ...base, namedGraphUri: artifact.named_graph_uri as string } : base;
}

class FakeShapesProvider {
    inspectCalls = 0;
    async inspectShapes() {
        this.inspectCalls += 1;
        return { constraints: [{ path: "urn:p", component: "urn:c" }], executorName: "pySHACL", executorVersion: "0.40.0" };
    }
    async validate(): Promise<any> { throw new Error("resolver-selection tests never run validation"); }
}

/** A DB proxy that FAILS LOUDLY if the pinned path ever reads a family's current pointer. */
function currentPointerTrap(db: FakeDb) {
    return new Proxy(db, {
        get(target: any, property) {
            if (property === "findFamilyByKey") {
                return async (familyKey: string) => {
                    const family = await target.findFamilyByKey(familyKey);
                    if (!family) return null;
                    // Identity check is legitimate; reading current_artifact_id is not.
                    return new Proxy(family, {
                        get(row: any, field) {
                            if (field === "current_artifact_id") throw new Error("pinned resolution must never read current_artifact_id");
                            return row[field];
                        },
                    });
                };
            }
            const value = target[property];
            return typeof value === "function" ? value.bind(target) : value;
        },
    }) as FakeDb;
}

async function expectContextCode(promise: Promise<unknown>, code: string) {
    const error = await promise.then(() => null, (e) => e);
    assert.ok(error instanceof SemanticContextError, `expected SemanticContextError, got ${error}`);
    assert.equal((error as any).code, code);
}

/* ------------------------------------------------------------------ B: IDS ---- */

test("pinned IDS: the captured active revision resolves by id", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const { artifact } = await seed(db, next, IDS, "1.0.0", { current: true });
    const resolved = await new IdsProfileResolver(db, artifactRoot).resolveByArtifactId(selectionOf(IDS, artifact) as any);
    assert.equal(resolved.artifactId, Number(artifact.id));
    assert.equal(resolved.version, "1.0.0");
    assert.equal(resolved.sha256, artifact.sha256);
    assert.ok(resolved.absolutePath.startsWith(artifactRoot));
});

test("pinned IDS: the same artifact still resolves once its lifecycle becomes superseded", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const { artifact } = await seed(db, next, IDS, "1.0.0", { current: true });
    const selection = selectionOf(IDS, artifact);
    artifact.lifecycle_status = "superseded";
    const resolved = await new IdsProfileResolver(db, artifactRoot).resolveByArtifactId(selection as any);
    assert.equal(resolved.artifactId, Number(artifact.id));
});

test("pinned IDS: moving the current pointer to another revision does not change the pinned resolution", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const source = await seed(db, next, IDS, "1.0.0", { current: true });
    const selection = selectionOf(IDS, source.artifact);
    const target = await seed(db, next, IDS, "1.1.0");
    // Simulate a Change-B-style activation landing mid-attempt.
    source.artifact.lifecycle_status = "superseded";
    target.artifact.lifecycle_status = "active";
    source.family.current_artifact_id = Number(target.artifact.id);

    const resolved = await new IdsProfileResolver(currentPointerTrap(db), artifactRoot).resolveByArtifactId(selection as any);
    assert.equal(resolved.artifactId, Number(source.artifact.id), "must still resolve the OLD pinned id");
    assert.equal(resolved.version, "1.0.0");
    assert.notEqual(resolved.artifactId, Number(target.artifact.id));
});

for (const lifecycle of ["retired", "failed"] as const) {
    test(`pinned IDS: a ${lifecycle} revision fails closed as revoked`, async () => {
        const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
        const { artifact } = await seed(db, next, IDS, "1.0.0", { current: true });
        const selection = selectionOf(IDS, artifact);
        artifact.lifecycle_status = lifecycle;
        await expectContextCode(new IdsProfileResolver(db, artifactRoot).resolveByArtifactId(selection as any), "pinned_artifact_revoked");
    });
}

for (const lifecycle of ["staged", "validated"] as const) {
    test(`pinned IDS: a never-activated ${lifecycle} revision fails closed as not yet eligible`, async () => {
        const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
        const { artifact } = await seed(db, next, IDS, "1.0.0", { lifecycle });
        await expectContextCode(
            new IdsProfileResolver(db, artifactRoot).resolveByArtifactId(selectionOf(IDS, artifact) as any),
            "pinned_artifact_not_yet_eligible");
    });
}

test("pinned IDS: a snapshot semanticVersion mismatch fails closed as revision drift", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const { artifact } = await seed(db, next, IDS, "1.0.0", { current: true });
    const selection = { ...selectionOf(IDS, artifact), semanticVersion: "1.1.0" };
    await expectContextCode(new IdsProfileResolver(db, artifactRoot).resolveByArtifactId(selection as any), "pinned_artifact_revision_drift");
});

test("pinned IDS: a snapshot sha256 mismatch fails closed as revision drift", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const { artifact } = await seed(db, next, IDS, "1.0.0", { current: true });
    const selection = { ...selectionOf(IDS, artifact), sha256: "f".repeat(64) };
    await expectContextCode(new IdsProfileResolver(db, artifactRoot).resolveByArtifactId(selection as any), "pinned_artifact_revision_drift");
});

test("pinned IDS: an artifact from the wrong family fails closed", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    await seed(db, next, IDS, "1.0.0", { current: true });
    const mapping = await seed(db, next, MAPPING, "1.0.0", { current: true });
    const selection = { ...selectionOf(MAPPING, mapping.artifact), familyKey: IDS };
    await expectContextCode(new IdsProfileResolver(db, artifactRoot).resolveByArtifactId(selection as any), "pinned_artifact_family_mismatch");
});

test("pinned IDS: a vanished artifact id fails closed", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const { artifact } = await seed(db, next, IDS, "1.0.0", { current: true });
    const selection = { ...selectionOf(IDS, artifact), artifactId: 987654 };
    await expectContextCode(new IdsProfileResolver(db, artifactRoot).resolveByArtifactId(selection as any), "pinned_artifact_missing");
});

/* -------------------------------------------------------------- C: mapping ---- */

test("pinned mapping: the captured active revision resolves by id and returns a validated profile", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const { artifact } = await seed(db, next, MAPPING, "1.1.0", { current: true });
    const resolved = await new MappingProfileService(db).resolveByArtifactId(selectionOf(MAPPING, artifact) as any, artifactRoot);
    assert.equal(resolved.artifactId, Number(artifact.id));
    assert.equal(resolved.version, "1.1.0");
    assert.equal(resolved.profile.profileKey, "oswadt-ifc4-minimal-rdf-mapping");
});

test("pinned mapping: the existing filesystem SHA-256 verification still runs", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const { artifact } = await seed(db, next, MAPPING, "1.1.0", { current: true });
    const selection = selectionOf(MAPPING, artifact);
    // Tamper with the bytes on disk while leaving the registry row (and the snapshot) intact.
    const onDisk = path.join(artifactRoot, artifact.repository_relative_path);
    const original = fs.readFileSync(onDisk);
    fs.writeFileSync(onDisk, JSON.stringify({ ...realMappingProfile, version: "1.1.0", tampered: true }));
    try {
        await assert.rejects(
            new MappingProfileService(db).resolveByArtifactId(selection as any, artifactRoot),
            /integrity check failed/);
    } finally {
        fs.writeFileSync(onDisk, original);
    }
});

test("pinned mapping: the current pointer can move to 1.1.0 while the pinned 1.0.0 still resolves by id", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const source = await seed(db, next, MAPPING, "1.0.0", { current: true });
    const selection = selectionOf(MAPPING, source.artifact);
    const target = await seed(db, next, MAPPING, "1.1.0");
    source.artifact.lifecycle_status = "superseded";
    target.artifact.lifecycle_status = "active";
    source.family.current_artifact_id = Number(target.artifact.id);

    const resolved = await new MappingProfileService(currentPointerTrap(db)).resolveByArtifactId(selection as any, artifactRoot);
    assert.equal(resolved.version, "1.0.0");
    assert.equal(resolved.artifactId, Number(source.artifact.id));
});

for (const lifecycle of ["retired", "failed"] as const) {
    test(`pinned mapping: a ${lifecycle} revision fails closed`, async () => {
        const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
        const { artifact } = await seed(db, next, MAPPING, "1.1.0", { current: true });
        const selection = selectionOf(MAPPING, artifact);
        artifact.lifecycle_status = lifecycle;
        await expectContextCode(new MappingProfileService(db).resolveByArtifactId(selection as any, artifactRoot), "pinned_artifact_revoked");
    });
}

test("pinned mapping: staged/validated, drift and wrong family all fail closed", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const staged = await seed(db, next, MAPPING, "1.0.0", { lifecycle: "staged" });
    await expectContextCode(new MappingProfileService(db).resolveByArtifactId(selectionOf(MAPPING, staged.artifact) as any, artifactRoot),
        "pinned_artifact_not_yet_eligible");
    const active = await seed(db, next, MAPPING, "1.1.0", { current: true });
    await expectContextCode(
        new MappingProfileService(db).resolveByArtifactId({ ...selectionOf(MAPPING, active.artifact), sha256: "e".repeat(64) } as any, artifactRoot),
        "pinned_artifact_revision_drift");
    const ids = await seed(db, next, IDS, "1.1.0", { current: true });
    await expectContextCode(
        new MappingProfileService(db).resolveByArtifactId({ ...selectionOf(IDS, ids.artifact), familyKey: MAPPING } as any, artifactRoot),
        "pinned_artifact_family_mismatch");
});

/* --------------------------------------------------------------- D: shapes ---- */

test("pinned shapes: the captured active graph-backed revision resolves by id and is inspected", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const { artifact } = await seed(db, next, SHAPES, "1.1.0", { current: true });
    const provider = new FakeShapesProvider();
    const resolved = await new ShapeSetService(db, provider as any).resolveByArtifactId(selectionOf(SHAPES, artifact) as any);
    assert.equal(resolved.artifactId, Number(artifact.id));
    assert.equal(resolved.source, "governed_active_shapes");
    assert.equal(resolved.namedGraphUri, artifact.named_graph_uri);
    assert.equal(provider.inspectCalls, 1, "provider.inspectShapes must still run on the pinned path");
    assert.equal(resolved.constraints.length, 1);
});

test("pinned shapes: a superseded graph-backed revision remains resolvable", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const { artifact } = await seed(db, next, SHAPES, "1.0.0", { current: true });
    const selection = selectionOf(SHAPES, artifact);
    artifact.lifecycle_status = "superseded";
    const resolved = await new ShapeSetService(db, new FakeShapesProvider() as any).resolveByArtifactId(selection as any);
    assert.equal(resolved.artifactId, Number(artifact.id));
});

test("pinned shapes: current pointer movement does not affect the pinned selection", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const source = await seed(db, next, SHAPES, "1.0.0", { current: true });
    const selection = selectionOf(SHAPES, source.artifact);
    const target = await seed(db, next, SHAPES, "1.1.0");
    source.artifact.lifecycle_status = "superseded";
    target.artifact.lifecycle_status = "active";
    source.family.current_artifact_id = Number(target.artifact.id);

    const resolved = await new ShapeSetService(currentPointerTrap(db), new FakeShapesProvider() as any).resolveByArtifactId(selection as any);
    assert.equal(resolved.artifactId, Number(source.artifact.id));
    assert.equal(resolved.version, "1.0.0");
});

test("pinned shapes: a namedGraphUri snapshot mismatch fails closed as revision drift", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const { artifact } = await seed(db, next, SHAPES, "1.1.0", { current: true });
    const selection = { ...selectionOf(SHAPES, artifact), namedGraphUri: "http://oswadt.test/id/graph/shapes/structural/deadbeef" };
    await expectContextCode(new ShapeSetService(db, new FakeShapesProvider() as any).resolveByArtifactId(selection as any),
        "pinned_artifact_revision_drift");
});

test("pinned shapes: a snapshot sha256 mismatch fails closed as revision drift", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const { artifact } = await seed(db, next, SHAPES, "1.1.0", { current: true });
    const selection = { ...selectionOf(SHAPES, artifact), sha256: "c".repeat(64) };
    await expectContextCode(new ShapeSetService(db, new FakeShapesProvider() as any).resolveByArtifactId(selection as any),
        "pinned_artifact_revision_drift");
});

test("pinned shapes: the existing file hash / byte-size verification still runs", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const { artifact } = await seed(db, next, SHAPES, "1.0.0", { current: true });
    const selection = selectionOf(SHAPES, artifact);
    const onDisk = path.join(artifactRoot, artifact.repository_relative_path);
    const original = fs.readFileSync(onDisk);
    fs.writeFileSync(onDisk, `${SHAPES_TURTLE}\n# tampered\n`);
    try {
        await assert.rejects(
            new ShapeSetService(db, new FakeShapesProvider() as any).resolveByArtifactId(selection as any),
            /hash or size verification/);
    } finally {
        fs.writeFileSync(onDisk, original);
    }
});

for (const lifecycle of ["retired", "failed"] as const) {
    test(`pinned shapes: a ${lifecycle} revision fails closed`, async () => {
        const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
        const { artifact } = await seed(db, next, SHAPES, "1.1.0", { current: true });
        const selection = selectionOf(SHAPES, artifact);
        artifact.lifecycle_status = lifecycle;
        await expectContextCode(new ShapeSetService(db, new FakeShapesProvider() as any).resolveByArtifactId(selection as any),
            "pinned_artifact_revoked");
    });
}

test("pinned shapes: a never-activated revision and a wrong-family artifact both fail closed", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const staged = await seed(db, next, SHAPES, "1.0.0", { lifecycle: "validated" });
    await expectContextCode(new ShapeSetService(db, new FakeShapesProvider() as any).resolveByArtifactId(selectionOf(SHAPES, staged.artifact) as any),
        "pinned_artifact_not_yet_eligible");
    const mapping = await seed(db, next, MAPPING, "1.0.0", { current: true });
    await expectContextCode(
        new ShapeSetService(db, new FakeShapesProvider() as any).resolveByArtifactId(
            { ...selectionOf(MAPPING, mapping.artifact), familyKey: SHAPES, namedGraphUri: "urn:none" } as any),
        "pinned_artifact_family_mismatch");
});

/* ------------------------------------------ E: no active re-resolution at all ---- */

test("no authoritative resolver reads current_artifact_id once a context exists", async () => {
    const db = new FakeSemanticArtifactDatabase(); const next = uuidSequence();
    const ids = await seed(db, next, IDS, "1.0.0", { current: true });
    const mapping = await seed(db, next, MAPPING, "1.0.0", { current: true });
    const shapes = await seed(db, next, SHAPES, "1.0.0", { current: true });
    const trapped = currentPointerTrap(db);

    const idsResult = await new IdsProfileResolver(trapped, artifactRoot).resolveByArtifactId(selectionOf(IDS, ids.artifact) as any);
    const mappingResult = await new MappingProfileService(trapped).resolveByArtifactId(selectionOf(MAPPING, mapping.artifact) as any, artifactRoot);
    const shapesResult = await new ShapeSetService(trapped, new FakeShapesProvider() as any).resolveByArtifactId(selectionOf(SHAPES, shapes.artifact) as any);

    assert.equal(idsResult.artifactId, Number(ids.artifact.id));
    assert.equal(mappingResult.artifactId, Number(mapping.artifact.id));
    assert.equal(shapesResult.artifactId, Number(shapes.artifact.id));

    // And the corresponding "active" resolvers WOULD have read the pointer — proving the trap works.
    await assert.rejects(new IdsProfileResolver(trapped, artifactRoot).resolveActive(IDS), /never read current_artifact_id/);
    await assert.rejects(new MappingProfileService(trapped).resolveActive(MAPPING, artifactRoot), /never read current_artifact_id/);
    await assert.rejects(new ShapeSetService(trapped, new FakeShapesProvider() as any).resolveGoverned(SHAPES), /never read current_artifact_id/);
});
