/**
 * Change C (A + G): the coherent semantic execution context snapshot and its
 * per-family fail-closed eligibility gate. Independently versioned governed families are
 * ACCEPTED — runtime never infers compatibility from equal version numbers. These tests
 * exercise the REAL builder against the shared
 * FakeSemanticArtifactDatabase, whose resolveCurrentArtifactSet mirrors the production
 * single-statement LEFT JOIN contract (missing family absent, NULL pointer observable).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    buildSemanticExecutionContext,
    SemanticContextError,
    DEFAULT_SEMANTIC_CONTEXT_FAMILY_KEYS,
} from "../../modelIntake/semanticExecutionContext.ts";
import { FakeSemanticArtifactDatabase } from "../helpers/fakeSemanticArtifacts.ts";
import type { ArtifactStorageMode } from "../../semantic/artifactTypes.ts";

const IDS = "oswadt-ifc4-model-requirements";
const MAPPING = "oswadt-ifc4-minimal-rdf-mapping";
const SHAPES = "oswadt-model-rdf-structural-shapes";

const STORAGE: Record<string, ArtifactStorageMode> = {
    [IDS]: "file_executed",
    [MAPPING]: "file_executed",
    [SHAPES]: "graph_backed",
};

function uuidSequence(): () => string {
    let value = 0;
    return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

/**
 * Seeds one family with one revision and (optionally) makes it the current pointer.
 * `lifecycle` lets a test seed a committed state the governed activation path would
 * never produce (e.g. a current pointer at a 'staged' revision).
 */
export async function seedFamilyRevision(
    db: FakeSemanticArtifactDatabase,
    nextUuid: () => string,
    familyKey: string,
    version: string,
    options: { current?: boolean; lifecycle?: "staged" | "validated" | "active" | "superseded" | "retired" | "failed" } = {},
) {
    const storageMode = STORAGE[familyKey] ?? "file_executed";
    const family = await db.ensureFamily({
        familyUuid: nextUuid(),
        artifactType: storageMode === "graph_backed" ? "shacl_shapes" : familyKey === MAPPING ? "ifc_rdf_mapping" : "ids_profile",
        familyKey,
        name: familyKey,
        semanticUri: `https://example.test/${familyKey}`,
        privacyPolicy: "public_research_artifact",
    });
    const artifact = await db.ensureArtifact({
        artifactUuid: nextUuid(),
        familyId: Number(family.id),
        semanticVersion: version,
        sourceFilename: `${familyKey}-${version}.dat`,
        repositoryRelativePath: `runtime/${familyKey}/${version}/file`,
        byteSize: 100,
        sha256: `sha:${familyKey}:${version}`,
        mediaType: "application/json",
        serialization: "json",
        semanticUri: `https://example.test/${familyKey}/${version}`,
        storageMode,
        namedGraphUri: storageMode === "graph_backed" ? `https://example.test/graphs/${familyKey}/${version}` : null,
        sourcePackageName: "oswadt-change-c",
        sourcePackageVersion: version,
        sourceReleaseStatus: "stable",
        privacyClassification: "public_research_artifact",
        predecessorArtifactId: null,
    });
    artifact.validation_status = storageMode === "graph_backed" ? "graph_verified" : "file_verified";
    artifact.lifecycle_status = options.lifecycle ?? (options.current ? "active" : "validated");
    if (options.current) family.current_artifact_id = Number(artifact.id);
    return { family, artifact };
}

/** Seeds a full triplet where each family's current pointer sits at the given version. */
async function seedTriplet(versions: { ids: string; mapping: string; shapes: string }, lifecycle?: "staged") {
    const db = new FakeSemanticArtifactDatabase();
    const nextUuid = uuidSequence();
    const ids = await seedFamilyRevision(db, nextUuid, IDS, versions.ids, { current: true, ...(lifecycle ? { lifecycle } : {}) });
    const mapping = await seedFamilyRevision(db, nextUuid, MAPPING, versions.mapping, { current: true, ...(lifecycle ? { lifecycle } : {}) });
    const shapes = await seedFamilyRevision(db, nextUuid, SHAPES, versions.shapes, { current: true, ...(lifecycle ? { lifecycle } : {}) });
    return { db, ids, mapping, shapes };
}

async function expectCode(promise: Promise<unknown>, code: string) {
    const error = await promise.then(() => null, (e) => e);
    assert.ok(error instanceof SemanticContextError, `expected SemanticContextError, got ${error}`);
    assert.equal((error as SemanticContextError).code, code);
}

test("the exact 1.0.0 source triplet builds a pinned execution context", async () => {
    const { db, ids, mapping, shapes } = await seedTriplet({ ids: "1.0.0", mapping: "1.0.0", shapes: "1.0.0" });
    const context = await buildSemanticExecutionContext(db, DEFAULT_SEMANTIC_CONTEXT_FAMILY_KEYS);

    assert.equal(context.ids.artifactId, Number(ids.artifact.id));
    assert.equal(context.ids.familyKey, IDS);
    assert.equal(context.ids.semanticVersion, "1.0.0");
    assert.equal(context.ids.sha256, ids.artifact.sha256);
    assert.equal(context.mapping.artifactId, Number(mapping.artifact.id));
    assert.equal(context.mapping.semanticVersion, "1.0.0");
    assert.equal(context.shapes.artifactId, Number(shapes.artifact.id));
    assert.equal(context.shapes.namedGraphUri, shapes.artifact.named_graph_uri);
    assert.ok(Object.isFrozen(context) && Object.isFrozen(context.ids), "the context must be immutable");
});

test("the exact 1.1.0 target triplet builds a pinned execution context", async () => {
    const { db } = await seedTriplet({ ids: "1.1.0", mapping: "1.1.0", shapes: "1.1.0" });
    const context = await buildSemanticExecutionContext(db);
    assert.deepEqual(
        [context.ids.semanticVersion, context.mapping.semanticVersion, context.shapes.semanticVersion],
        ["1.1.0", "1.1.0", "1.1.0"],
    );
});

test("the snapshot is captured in exactly ONE resolveCurrentArtifactSet call with the three governed keys", async () => {
    const { db } = await seedTriplet({ ids: "1.0.0", mapping: "1.0.0", shapes: "1.0.0" });
    const calls: string[][] = [];
    const spy = {
        resolveCurrentArtifactSet: async (keys: string[]) => { calls.push([...keys]); return db.resolveCurrentArtifactSet(keys); },
    };
    await buildSemanticExecutionContext(spy);
    assert.equal(calls.length, 1, "the whole context must come from a single snapshot statement");
    assert.deepEqual(calls[0], [IDS, MAPPING, SHAPES]);
});

test("a missing governed family fails closed", async () => {
    const db = new FakeSemanticArtifactDatabase();
    const nextUuid = uuidSequence();
    await seedFamilyRevision(db, nextUuid, IDS, "1.0.0", { current: true });
    await seedFamilyRevision(db, nextUuid, MAPPING, "1.0.0", { current: true });
    await expectCode(buildSemanticExecutionContext(db), "semantic_context_family_missing");
});

test("a NULL current pointer fails closed", async () => {
    const { db, shapes } = await seedTriplet({ ids: "1.0.0", mapping: "1.0.0", shapes: "1.0.0" });
    shapes.family.current_artifact_id = null;
    await expectCode(buildSemanticExecutionContext(db), "semantic_context_current_pointer_missing");
});

test("a dangling current pointer (no such artifact row) fails closed", async () => {
    const { db, mapping } = await seedTriplet({ ids: "1.0.0", mapping: "1.0.0", shapes: "1.0.0" });
    mapping.family.current_artifact_id = 999999;
    await expectCode(buildSemanticExecutionContext(db), "semantic_context_current_pointer_missing");
});

test("a current artifact belonging to a different family fails closed", async () => {
    const { db, ids, mapping } = await seedTriplet({ ids: "1.0.0", mapping: "1.0.0", shapes: "1.0.0" });
    // Point the IDS family at the MAPPING family's artifact: coherent snapshot, broken linkage.
    ids.family.current_artifact_id = Number(mapping.artifact.id);
    await expectCode(buildSemanticExecutionContext(db), "semantic_context_family_linkage_invalid");
});

test("a capture-time non-active lifecycle (all three staged) fails closed", async () => {
    const { db } = await seedTriplet({ ids: "1.0.0", mapping: "1.0.0", shapes: "1.0.0" }, "staged");
    await expectCode(buildSemanticExecutionContext(db), "semantic_context_artifact_not_active");
});

test("an unverified current artifact fails closed on the per-family storage contract", async () => {
    const { db, ids } = await seedTriplet({ ids: "1.0.0", mapping: "1.0.0", shapes: "1.0.0" });
    ids.artifact.validation_status = "integrity_validated";
    await expectCode(buildSemanticExecutionContext(db), "semantic_context_artifact_ineligible");
});

test("a graph-backed shapes artifact with no named graph URI fails closed", async () => {
    const { db, shapes } = await seedTriplet({ ids: "1.0.0", mapping: "1.0.0", shapes: "1.0.0" });
    shapes.artifact.named_graph_uri = null;
    await expectCode(buildSemanticExecutionContext(db), "semantic_context_artifact_ineligible");
});

/* ------- Independently versioned governed families are ACCEPTED (frozen governance) -------
 *
 * IDS, mapping and SHACL shapes are independently versioned. Runtime must NOT infer
 * compatibility from equal version numbers: the BIM manager decides which combination is
 * valid by activating it. These tests assert ONLY that the builder does not reject a set
 * because the version numbers differ — they assert nothing about semantic compatibility.
 */
for (const combination of [
    { ids: "1.0.0", mapping: "1.0.0", shapes: "1.0.0" },
    { ids: "1.1.0", mapping: "1.1.0", shapes: "1.1.0" },
    { ids: "1.2.0", mapping: "1.1.0", shapes: "1.1.0" },
    { ids: "1.2.0", mapping: "1.3.0", shapes: "1.1.0" },
    { ids: "2.0.0", mapping: "1.0.0", shapes: "3.5.1" },
]) {
    test(`an independently versioned active set (ids=${combination.ids}, mapping=${combination.mapping}, shapes=${combination.shapes}) is accepted`, async () => {
        const { db, ids, mapping, shapes } = await seedTriplet(combination);
        const context = await buildSemanticExecutionContext(db);
        assert.deepEqual(
            [context.ids.semanticVersion, context.mapping.semanticVersion, context.shapes.semanticVersion],
            [combination.ids, combination.mapping, combination.shapes],
        );
        // The captured set is exactly what the three current pointers named.
        assert.equal(context.ids.artifactId, Number(ids.artifact.id));
        assert.equal(context.mapping.artifactId, Number(mapping.artifact.id));
        assert.equal(context.shapes.artifactId, Number(shapes.artifact.id));
    });
}

test("no cross-family version comparison exists anywhere in the context builder", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("modelIntake/semanticExecutionContext.ts", "utf8");
    assert.doesNotMatch(source, /incompatible_set|SUPPORTED_COMPATIBILITY_SETS|COMPATIBILITY_FAMILY_KEYS/,
        "the equal-semantic-version compatibility gate must be gone");
    assert.doesNotMatch(source, /versions\.ids === |versions\.mapping === |versions\.shapes === /,
        "no version-tuple equality check may remain");
    const importedModules = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    assert.ok(!importedModules.some((m) => m!.includes("ifc4x3TripletActivationService")),
        `Change C selection must not import Change B's rollout-scoped activation descriptor; imports=${importedModules.join(", ")}`);
    // ...and Change B's own file must be back to its pre-Change-C API (no exported constants).
    const changeB = fs.readFileSync("semantic/ifc4x3TripletActivationService.ts", "utf8");
    assert.match(changeB, /^const IFC4X3_SOURCE_VERSION = "1\.0\.0";$/m);
    assert.doesNotMatch(changeB, /export const IFC4X3_/);
});

test("a per-family eligibility failure still fails closed even when versions are equal", async () => {
    // Proves the removal was surgical: only the CROSS-FAMILY rule went away.
    const { db, mapping } = await seedTriplet({ ids: "1.2.0", mapping: "1.2.0", shapes: "1.2.0" });
    mapping.artifact.storage_mode = "graph_backed";
    await expectCode(buildSemanticExecutionContext(db), "semantic_context_artifact_ineligible");
});

test("resolveCurrentArtifactSet rejects an empty key list and duplicate keys (caller-contract violations)", async () => {
    const db = new FakeSemanticArtifactDatabase();
    await assert.rejects(db.resolveCurrentArtifactSet([]), /at least one family key/);
    await assert.rejects(db.resolveCurrentArtifactSet([IDS, IDS]), /duplicate family keys/);
});

/* --------------------- Change C item 8: preview routes stay unpinned ---------------------- */

test("preview endpoints still resolve the currently ACTIVE artifacts, with no pinning", async () => {
    const fs = await import("node:fs");
    const routes = fs.readFileSync("routes/modelIntake.ts", "utf8");
    const intake = fs.readFileSync("modelIntake/modelIntakeService.ts", "utf8");
    const validation = fs.readFileSync("semanticValidation/semanticValidationService.ts", "utf8");

    // GET /modelIntake/context -> service.context() + governedContext(); both unpinned.
    assert.match(routes, /await service\.context\(\)/);
    assert.match(routes, /await semanticValidation\.governedContext\(\)/);
    assert.match(validation, /async governedContext\(\)[\s\S]*?this\.shapes\.resolveGoverned\(config\.modelShapesFamilyKey\)/);
    // POST /modelIntake/shacl/inspect and /shacl/validate -> inspectGoverned(), unchanged.
    assert.match(validation, /async inspectGoverned\(\) \{ return this\.shapes\.resolveGoverned\(\); \}/);
    assert.equal((routes.match(/semanticValidation\.inspectGoverned\(\)/g) ?? []).length, 2);
    assert.doesNotMatch(routes, /inspectPinned|resolveByArtifactId|buildSemanticExecutionContext/);
    // The standalone POST /modelIntake/preflight route passes NO context argument.
    assert.match(routes, /service\.preflight\(\{ ifcFile: selected\.ifcFile,/);
    // ModelIntakeService.context() keeps calling resolveActive for both IDS and mapping.
    assert.match(intake, /const ids = await this\.resolveProfile\(crypto\.randomUUID\(\)\);/);
    assert.match(intake, /const mapping = await this\.mappings\.resolveActive\(config\.mappingFamilyKey, config\.artifactRoot\);\r?\n        return \{/);
    // The authoritative createVersion path captures exactly ONE context and never refreshes it.
    assert.equal((intake.match(/buildSemanticExecutionContext\(/g) ?? []).length, 1);
    assert.match(intake, /this\.preflight\(input, false, semanticContext\)/);
    assert.match(intake, /this\.resolveProfile\(current\.runUuid, semanticContext\)/);
});

/* ------- Controlled intake always executes the governed, pinned IDS revision ------- */

test("controlled createVersion can only ever execute the governed, pinned IDS revision", async () => {
    const fs = await import("node:fs");
    const intake = fs.readFileSync("modelIntake/modelIntakeService.ts", "utf8");
    const createVersion = intake.slice(intake.indexOf("async createVersion("),
        intake.indexOf("private async resolveProfile("));

    // Option B: there is no IDS input to guard against inside the service any more — the
    // DTO simply has no IDS field, and a legacy caller is rejected at the route boundary
    // (proved over real HTTP in modelIntakeGovernedIdsOnly.test.ts).
    assert.doesNotMatch(createVersion, /idsMode/);
    assert.doesNotMatch(createVersion, /idsFile/);
    // It captures the context and passes it to the upload service.
    assert.match(createVersion, /buildSemanticExecutionContext\(this\.artifactDatabase\)/);
    assert.match(createVersion, /controlledIntake: \{ idsProfile: absoluteProfile, semanticContext \}/);
    // The profile handed to the upload service comes from the PINNED context only.
    assert.match(createVersion, /this\.resolveProfile\(current\.runUuid, semanticContext\)/);
});

test("no model-intake code path can reach an uploaded/temporary IDS profile", async () => {
    const fs = await import("node:fs");
    const intake = fs.readFileSync("modelIntake/modelIntakeService.ts", "utf8");
    const routes = fs.readFileSync("routes/modelIntake.ts", "utf8");

    // Strip comments so prose explaining the removal cannot satisfy these assertions.
    const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const [name, source] of [["service", code(intake)], ["routes", code(routes)]] as const) {
        assert.doesNotMatch(source, /temporary_uploaded_profile/, `${name} must not produce a temporary IDS profile`);
        assert.doesNotMatch(source, /temporary-upload/, `${name} must not mint a temporary IDS family key`);
        assert.doesNotMatch(source, /temporary_ids_disabled|ids_file_required|unexpected_ids_file|ids_too_large/,
            `${name} must not retain uploaded-IDS validation errors`);
    }
    // The only surviving mentions of the legacy fields are the fail-closed route guard.
    assert.match(code(routes), /controlled_intake_requires_governed_ids/);
    assert.match(code(routes), /for \(const forbidden of \["idsMode", "idsFile"\]\)/);
    // ...and the service itself never mentions them at all.
    assert.doesNotMatch(code(intake), /idsMode|idsFile/);
});
