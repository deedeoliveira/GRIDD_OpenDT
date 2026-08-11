import assert from "node:assert/strict";
import test from "node:test";
import { Ifc4x3TripletActivationService } from "../../semantic/ifc4x3TripletActivationService.ts";
import { SemanticArtifactError } from "../../semantic/artifactTypes.ts";
import { FakeSemanticArtifactDatabase } from "../helpers/fakeSemanticArtifacts.ts";
import type { ArtifactStorageMode, PrivacyClassification } from "../../semantic/artifactTypes.ts";

const FAMILIES: Array<{ familyKey: string; storageMode: ArtifactStorageMode }> = [
    { familyKey: "oswadt-ifc4-model-requirements", storageMode: "file_executed" },
    { familyKey: "oswadt-ifc4-minimal-rdf-mapping", storageMode: "file_executed" },
    { familyKey: "oswadt-model-rdf-structural-shapes", storageMode: "graph_backed" },
];

function uuidSequence(): () => string {
    let value = 0;
    return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

/** Registers, verifies, and (optionally) activates one artifact revision for a family. */
async function registerRevision(
    database: FakeSemanticArtifactDatabase,
    nextUuid: () => string,
    familyKey: string,
    storageMode: ArtifactStorageMode,
    semanticVersion: string,
    opts: { activate: boolean; privacyClassification?: PrivacyClassification; lifecycleOverride?: "staged" }
) {
    const family = await database.ensureFamily({
        familyUuid: nextUuid(),
        artifactType: storageMode === "graph_backed" ? "shacl_shapes" : "ids_profile",
        familyKey,
        name: familyKey,
        semanticUri: `https://example.test/${familyKey}`,
        privacyPolicy: "public_research_artifact",
    });
    const artifact = await database.ensureArtifact({
        artifactUuid: nextUuid(),
        familyId: Number(family.id),
        semanticVersion,
        sourceFilename: `${familyKey}-${semanticVersion}.dat`,
        repositoryRelativePath: `runtime/${familyKey}/${semanticVersion}/file`,
        byteSize: 100,
        sha256: `${familyKey}:${semanticVersion}`,
        mediaType: "application/json",
        serialization: "json",
        semanticUri: `https://example.test/${familyKey}/${semanticVersion}`,
        storageMode,
        namedGraphUri: storageMode === "graph_backed" ? `https://example.test/graphs/${familyKey}/${semanticVersion}` : null,
        sourcePackageName: "oswadt-ifc4x3-compat",
        sourcePackageVersion: semanticVersion,
        sourceReleaseStatus: "stable",
        privacyClassification: opts.privacyClassification ?? "public_research_artifact",
        predecessorArtifactId: null,
    });

    const operation = await database.ensureOperation({
        operationUuid: nextUuid(),
        idempotencyKey: `setup:${familyKey}:${semanticVersion}`,
        artifactId: Number(artifact.id),
        operationType: opts.activate ? "load_and_activate" : "load_without_activation",
        payloadHash: `hash:${familyKey}:${semanticVersion}`,
        previousArtifactId: family.current_artifact_id === null ? null : Number(family.current_artifact_id),
    });

    if (!opts.lifecycleOverride) {
        if (storageMode === "graph_backed") {
            await database.markGraphVerified(operation.operation_uuid, Number(artifact.id), {
                integrity: { kind: "integrity_validation", sha256: artifact.sha256, byteSize: 100, expectedTripleCount: 1, mediaType: "text/turtle", serialization: "turtle", validatedAt: "2026-01-01T00:00:00.000Z" },
                fusekiLoading: { kind: "fuseki_parsing_loading_validation", accepted: true, graphUri: artifact.named_graph_uri! },
                postLoad: { kind: "post_load_graph_verification", tripleCount: 1, expectedResourcePresent: null },
            });
        } else {
            await database.markFileVerified(operation.operation_uuid, Number(artifact.id), { kind: "declarative_mapping_schema", accepted: true });
        }
    }

    if (opts.activate) {
        await database.activateArtifact({
            operationUuid: operation.operation_uuid,
            familyId: Number(family.id),
            artifactId: Number(artifact.id),
            expectedCurrentArtifactId: family.current_artifact_id === null ? null : Number(family.current_artifact_id),
        });
    }

    return { family: (await database.findFamilyByKey(familyKey))!, artifact: (await database.findArtifactById(Number(artifact.id)))! };
}

/** Sets up all three families with a 1.0.0 ACTIVE revision plus a registered-but-inactive 1.1.0 revision (Change A style). */
async function setupSourceCompleteWithTargetRegistered(overrides: Partial<Record<string, { activateTarget?: boolean; targetLifecycleOverride?: "staged"; targetVersion?: string; sourceVersion?: string }>> = {}) {
    const database = new FakeSemanticArtifactDatabase();
    const nextUuid = uuidSequence();
    for (const { familyKey, storageMode } of FAMILIES) {
        const override = overrides[familyKey] ?? {};
        await registerRevision(database, nextUuid, familyKey, storageMode, override.sourceVersion ?? "1.0.0", { activate: true });
        await registerRevision(database, nextUuid, familyKey, storageMode, override.targetVersion ?? "1.1.0", {
            activate: override.activateTarget ?? false,
            ...(override.targetLifecycleOverride ? { lifecycleOverride: override.targetLifecycleOverride } : {}),
        });
    }
    return { database, service: new Ifc4x3TripletActivationService(database, { newUuid: nextUuid }) };
}

function currentVersions(database: FakeSemanticArtifactDatabase): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const { familyKey } of FAMILIES) {
        const family = database.families.find((row) => row.family_key === familyKey)!;
        const artifact = family.current_artifact_id === null ? null : database.artifacts.find((row) => row.id === family.current_artifact_id);
        out[familyKey] = artifact ? artifact.semantic_version : null;
    }
    return out;
}

/* A. complete source set accepted */
test("complete 1.0.0 source set activates all three 1.1.0 targets atomically", async () => {
    const { database, service } = await setupSourceCompleteWithTargetRegistered();
    const result = await service.activateGovernedTargetSet();

    assert.equal(result.status, "activated");
    assert.equal(result.results.length, 3);
    assert.deepEqual(currentVersions(database), {
        "oswadt-ifc4-model-requirements": "1.1.0",
        "oswadt-ifc4-minimal-rdf-mapping": "1.1.0",
        "oswadt-model-rdf-structural-shapes": "1.1.0",
    });
    for (const familyKey of FAMILIES.map((f) => f.familyKey)) {
        const family = database.families.find((row) => row.family_key === familyKey)!;
        const source = database.artifacts.find((row) => row.family_id === family.id && row.semantic_version === "1.0.0")!;
        const target = database.artifacts.find((row) => row.family_id === family.id && row.semantic_version === "1.1.0")!;
        assert.equal(source.lifecycle_status, "superseded", `${familyKey} 1.0.0 must be superseded`);
        assert.equal(target.lifecycle_status, "active", `${familyKey} 1.1.0 must be active`);
    }
});

/* B. complete target set returns idempotent success */
test("complete 1.1.0 target set is idempotent (no-op, no pointer mutation)", async () => {
    const { database, service } = await setupSourceCompleteWithTargetRegistered();
    await service.activateGovernedTargetSet();
    const before = currentVersions(database);
    const beforeArtifacts = database.artifacts.map((row) => ({ id: row.id, lifecycle_status: row.lifecycle_status }));

    const second = await service.activateGovernedTargetSet();

    assert.equal(second.status, "already_active");
    assert.deepEqual(currentVersions(database), before);
    assert.deepEqual(database.artifacts.map((row) => ({ id: row.id, lifecycle_status: row.lifecycle_status })), beforeArtifacts);
});

/* C/D/E/F. mixed/partial states must fail closed, never auto-converge */
const mixedCases: Array<[string, Partial<Record<string, { activateTarget?: boolean }>>]> = [
    ["IDS target + mapping/shapes source", { "oswadt-ifc4-model-requirements": { activateTarget: true } }],
    ["mapping target + others source", { "oswadt-ifc4-minimal-rdf-mapping": { activateTarget: true } }],
    ["shapes target + others source", { "oswadt-model-rdf-structural-shapes": { activateTarget: true } }],
];
for (const [label, overrides] of mixedCases) {
    test(`mixed state (${label}) fails closed with activation_conflict and mutates nothing`, async () => {
        const { database, service } = await setupSourceCompleteWithTargetRegistered(overrides);
        const before = currentVersions(database);

        await assert.rejects(
            service.activateGovernedTargetSet(),
            (error: unknown) => error instanceof SemanticArtifactError && error.code === "activation_conflict"
        );

        assert.deepEqual(currentVersions(database), before, "no family pointer may change on a mixed state");
    });
}

/* G. NULL current pointer fails closed */
test("a family with a NULL current pointer fails closed (not a bootstrap operation)", async () => {
    const database = new FakeSemanticArtifactDatabase();
    const nextUuid = uuidSequence();
    for (const { familyKey, storageMode } of FAMILIES) {
        const shouldBootstrap = familyKey === "oswadt-ifc4-model-requirements";
        if (!shouldBootstrap) {
            await registerRevision(database, nextUuid, familyKey, storageMode, "1.0.0", { activate: true });
        } else {
            // Family exists (so findFamilyByKey succeeds) but has never been activated.
            await database.ensureFamily({
                familyUuid: nextUuid(),
                artifactType: "ids_profile",
                familyKey,
                name: familyKey,
                semanticUri: `https://example.test/${familyKey}`,
                privacyPolicy: "public_research_artifact",
            });
        }
        await registerRevision(database, nextUuid, familyKey, storageMode, "1.1.0", { activate: false });
    }
    const service = new Ifc4x3TripletActivationService(database, { newUuid: nextUuid });

    await assert.rejects(
        service.activateGovernedTargetSet(),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "activation_conflict"
    );
    assert.equal(database.families.find((f) => f.family_key === "oswadt-ifc4-model-requirements")!.current_artifact_id, null);
});

/* H. missing family in the requested target set fails closed */
test("a governed family that does not exist yet fails closed with artifact_not_found", async () => {
    const database = new FakeSemanticArtifactDatabase();
    const nextUuid = uuidSequence();
    // Only register two of the three families.
    await registerRevision(database, nextUuid, "oswadt-ifc4-model-requirements", "file_executed", "1.0.0", { activate: true });
    await registerRevision(database, nextUuid, "oswadt-ifc4-model-requirements", "file_executed", "1.1.0", { activate: false });
    await registerRevision(database, nextUuid, "oswadt-ifc4-minimal-rdf-mapping", "file_executed", "1.0.0", { activate: true });
    await registerRevision(database, nextUuid, "oswadt-ifc4-minimal-rdf-mapping", "file_executed", "1.1.0", { activate: false });
    const service = new Ifc4x3TripletActivationService(database, { newUuid: nextUuid });

    await assert.rejects(
        service.activateGovernedTargetSet(),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "artifact_not_found"
    );
});

/* I. target artifact wrong family/version fails closed */
test("a target artifact belonging to the wrong family is rejected before any write", async () => {
    const { database } = await setupSourceCompleteWithTargetRegistered();
    const nextUuid = uuidSequence();
    const families = FAMILIES.map(({ familyKey }) => database.families.find((f) => f.family_key === familyKey)!);
    const mappingTarget = database.artifacts.find((row) =>
        row.family_id === families[1]!.id && row.semantic_version === "1.1.0")!;
    const shapesTarget = database.artifacts.find((row) => row.family_id === families[2]!.id && row.semantic_version === "1.1.0")!;

    const before = currentVersions(database);
    // Bypass the service's own family-scoped lookup: hand the DB primitive a target
    // artifact id that does not actually belong to the family it is claimed for.
    await assert.rejects(
        database.activateArtifactSet({
            items: [
                { familyKey: families[0]!.family_key, targetArtifactId: database.artifacts.find((row) => row.family_id === families[0]!.id && row.semantic_version === "1.1.0")!.id, expectedSourceVersion: "1.0.0", targetVersion: "1.1.0", operationUuid: nextUuid() },
                { familyKey: families[1]!.family_key, targetArtifactId: mappingTarget.id, expectedSourceVersion: "1.0.0", targetVersion: "1.1.0", operationUuid: nextUuid() },
                { familyKey: families[2]!.family_key, targetArtifactId: shapesTarget.id, expectedSourceVersion: "1.0.0", targetVersion: "9.9.9", operationUuid: nextUuid() },
            ],
        }),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "activation_ineligible"
    );
    assert.deepEqual(currentVersions(database), before, "no partial write on a target eligibility failure");
});

/* J. target not verified/eligible fails closed */
test("a target artifact that was never verified is not eligible for activation", async () => {
    const { database, service } = await setupSourceCompleteWithTargetRegistered({
        "oswadt-ifc4-minimal-rdf-mapping": { targetLifecycleOverride: "staged" },
    });
    const before = currentVersions(database);

    await assert.rejects(
        service.activateGovernedTargetSet(),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "activation_ineligible"
    );
    assert.deepEqual(currentVersions(database), before, "no partial write when one target is unverified");
});

test("an unexpected current source version (neither the source nor target set) fails closed", async () => {
    const { database, service } = await setupSourceCompleteWithTargetRegistered({
        "oswadt-model-rdf-structural-shapes": { sourceVersion: "0.9.0" },
    });
    const before = currentVersions(database);

    await assert.rejects(
        service.activateGovernedTargetSet(),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "activation_conflict"
    );
    assert.deepEqual(currentVersions(database), before);
});

/* ===================== provenance regression: confirmed-bug reproduction ===================== */

test("REGRESSION (audit provenance): a mixed-state failure followed by external recovery and a valid retry records the TRUE 1.0.0 predecessor, never a stale/self-referencing one", async () => {
    const { database, service } = await setupSourceCompleteWithTargetRegistered({
        "oswadt-ifc4-model-requirements": { activateTarget: true },
    });
    const idsFamily = database.families.find((f) => f.family_key === "oswadt-ifc4-model-requirements")!;
    const idsSource = database.artifacts.find((a) => a.family_id === idsFamily.id && a.semantic_version === "1.0.0")!;
    const idsTarget = database.artifacts.find((a) => a.family_id === idsFamily.id && a.semantic_version === "1.1.0")!;

    // Attempt 1: IDS already at 1.1.0, mapping/shapes still at 1.0.0 — a mixed state.
    await assert.rejects(
        service.activateGovernedTargetSet(),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "activation_conflict"
    );

    // The three activate_existing operation rows survive the failed attempt.
    const survivingOps = database.operations.filter((op) => op.idempotency_key.startsWith("ifc4x3-triplet-activation:1.1.0:"));
    assert.equal(survivingOps.length, 3, "operation rows must survive a failed-closed attempt");

    // Controlled external recovery: IDS reverted to its true 1.0.0 source. Operation rows untouched.
    idsFamily.current_artifact_id = idsSource.id;
    idsSource.lifecycle_status = "active";
    idsTarget.lifecycle_status = "validated";

    // Retry the SAME governed target activation — now a genuinely valid 1.0.0/1.0.0/1.0.0 source.
    const result = await service.activateGovernedTargetSet();
    assert.equal(result.status, "activated");

    for (const { familyKey } of FAMILIES) {
        const family = database.families.find((f) => f.family_key === familyKey)!;
        const trueSource = database.artifacts.find((a) => a.family_id === family.id && a.semantic_version === "1.0.0")!;
        const op = database.operations.find((o) => o.idempotency_key === `ifc4x3-triplet-activation:1.1.0:${familyKey}`)!;
        assert.equal(op.status, "completed");
        assert.equal(op.previous_artifact_id, trueSource.id, `${familyKey}: completed operation must record the TRUE 1.0.0 predecessor`);
    }

    const idsOp = database.operations.find((o) => o.idempotency_key === "ifc4x3-triplet-activation:1.1.0:oswadt-ifc4-model-requirements")!;
    assert.notEqual(idsOp.previous_artifact_id, idsTarget.id, "the IDS row must never record its own target artifact as its predecessor (the originally reproduced defect)");
    assert.equal(idsOp.previous_artifact_id, idsSource.id);
});

/* ===================== EDGE CASE: target already complete without truthful triplet evidence ===================== */

/** Builds all three families ALREADY on 1.1.0, activated via ordinary single-artifact `activateArtifact` (an "other mechanism"), never through the triplet service. No `ifc4x3-triplet-activation:*` operation rows exist. */
async function setupTargetCompleteViaOtherMechanism() {
    const database = new FakeSemanticArtifactDatabase();
    const nextUuid = uuidSequence();
    for (const { familyKey, storageMode } of FAMILIES) {
        await registerRevision(database, nextUuid, familyKey, storageMode, "1.0.0", { activate: true });
        await registerRevision(database, nextUuid, familyKey, storageMode, "1.1.0", { activate: true });
    }
    return { database, service: new Ifc4x3TripletActivationService(database, { newUuid: nextUuid }) };
}

function tripletOps(database: FakeSemanticArtifactDatabase) {
    return database.operations.filter((op) => op.idempotency_key.startsWith("ifc4x3-triplet-activation:"));
}
function hasSelfReferentialCompleted(database: FakeSemanticArtifactDatabase): boolean {
    return tripletOps(database).some((op) => op.status === "completed" && op.previous_artifact_id === op.artifact_id);
}

/* A. full target before any triplet operation exists */
test("EDGE A: target already complete via another mechanism, no prior triplet operation -> fails closed, no fabricated evidence", async () => {
    const { database, service } = await setupTargetCompleteViaOtherMechanism();
    assert.equal(tripletOps(database).length, 0, "no triplet operations should pre-exist");

    await assert.rejects(
        service.activateGovernedTargetSet(),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "activation_conflict"
    );
    assert.equal(hasSelfReferentialCompleted(database), false, "must never leave completed self-referential provenance");
    assert.ok(tripletOps(database).every((op) => op.status !== "completed"), "no triplet operation may be marked completed without truthful evidence");
});

/* B. full target with newly-created/pending triplet operations (same as A, restated for explicitness — ensureOperation always creates pending rows before the transaction) */
test("EDGE B: target complete, newly-created pending triplet operations -> fails closed", async () => {
    const { database, service } = await setupTargetCompleteViaOtherMechanism();
    let code = "";
    try { await service.activateGovernedTargetSet(); } catch (e: any) { code = e?.code ?? ""; }
    assert.equal(code, "activation_conflict");
    for (const op of tripletOps(database)) {
        assert.notEqual(op.status, "completed");
    }
});

/* C. full target with stale pending operations from a failed mixed attempt */
test("EDGE C: target complete via stale pending operations left by a failed mixed attempt -> fails closed", async () => {
    const { database, service } = await setupSourceCompleteWithTargetRegistered({
        "oswadt-ifc4-model-requirements": { activateTarget: true },
    });
    await assert.rejects(service.activateGovernedTargetSet(), (e: unknown) => e instanceof SemanticArtifactError && e.code === "activation_conflict");

    // External recovery moves mapping/shapes to target TOO (not back to source) — operation rows untouched.
    for (const familyKey of ["oswadt-ifc4-minimal-rdf-mapping", "oswadt-model-rdf-structural-shapes"]) {
        const family = database.families.find((f) => f.family_key === familyKey)!;
        const target = database.artifacts.find((a) => a.family_id === family.id && a.semantic_version === "1.1.0")!;
        const source = database.artifacts.find((a) => a.family_id === family.id && a.semantic_version === "1.0.0")!;
        family.current_artifact_id = target.id;
        target.lifecycle_status = "active";
        source.lifecycle_status = "superseded";
    }

    await assert.rejects(
        service.activateGovernedTargetSet(),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "activation_conflict"
    );
    assert.equal(hasSelfReferentialCompleted(database), false);
});

/* D. full target with self-referential previous_artifact_id (directly crafted malformed evidence) */
test("EDGE D: target complete with a self-referential previous_artifact_id on one operation -> fails closed", async () => {
    const { database, service } = await setupSourceCompleteWithTargetRegistered();
    const result1 = await service.activateGovernedTargetSet();
    assert.equal(result1.status, "activated");

    // Corrupt one completed operation's provenance to be self-referential.
    const op = database.operations.find((o) => o.idempotency_key === "ifc4x3-triplet-activation:1.1.0:oswadt-ifc4-minimal-rdf-mapping")!;
    op.previous_artifact_id = op.artifact_id;

    await assert.rejects(
        service.activateGovernedTargetSet(),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "activation_conflict"
    );
});

/* E. full target with completed but wrong predecessor */
test("EDGE E: target complete with a completed operation recording the WRONG predecessor -> fails closed", async () => {
    const { database, service } = await setupSourceCompleteWithTargetRegistered();
    const result1 = await service.activateGovernedTargetSet();
    assert.equal(result1.status, "activated");

    const op = database.operations.find((o) => o.idempotency_key === "ifc4x3-triplet-activation:1.1.0:oswadt-model-rdf-structural-shapes")!;
    const wrongPredecessor = database.artifacts.find((a) =>
        database.families.find((f) => f.id === a.family_id)?.family_key === "oswadt-ifc4-minimal-rdf-mapping" && a.semantic_version === "1.0.0")!;
    op.previous_artifact_id = wrongPredecessor.id;

    await assert.rejects(
        service.activateGovernedTargetSet(),
        (error: unknown) => error instanceof SemanticArtifactError && error.code === "activation_conflict"
    );
});

/* F. full target with all three correct completed triplet operations -> succeeds */
test("EDGE F: target complete with truthful, correctly-completed triplet evidence for all three -> succeeds", async () => {
    const { database, service } = await setupSourceCompleteWithTargetRegistered();
    const result1 = await service.activateGovernedTargetSet();
    assert.equal(result1.status, "activated");

    const result2 = await service.activateGovernedTargetSet();
    assert.equal(result2.status, "already_active");
    for (const op of tripletOps(database)) {
        assert.equal(op.status, "completed");
        assert.notEqual(op.previous_artifact_id, op.artifact_id);
    }
});

/* H. two "concurrent" (fake-serialized) callers from source both resolve coherently */
test("EDGE H: two callers racing from full source resolve to one activated + one already_active, with truthful shared evidence", async () => {
    const { database, service } = await setupSourceCompleteWithTargetRegistered();
    const [a, b] = await Promise.allSettled([service.activateGovernedTargetSet(), service.activateGovernedTargetSet()]);
    const fulfilled = [a, b].filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    assert.equal(fulfilled.length, 2, "the fake's per-family lock queue must serialize both callers to success, not fail either");
    const statuses = fulfilled.map((r) => r.value.status).sort();
    assert.deepEqual(statuses, ["activated", "already_active"]);
    for (const familyKey of FAMILIES.map((f) => f.familyKey)) {
        const family = database.families.find((f) => f.family_key === familyKey)!;
        const trueSource = database.artifacts.find((a) => a.family_id === family.id && a.semantic_version === "1.0.0")!;
        const op = database.operations.find((o) => o.idempotency_key === `ifc4x3-triplet-activation:1.1.0:${familyKey}`)!;
        assert.equal(op.previous_artifact_id, trueSource.id);
    }
});

test("REGRESSION (audit provenance): a target-complete idempotent re-run never rewrites previous_artifact_id", async () => {
    const { database, service } = await setupSourceCompleteWithTargetRegistered();
    const first = await service.activateGovernedTargetSet();
    assert.equal(first.status, "activated");

    const originalPredecessors = new Map(
        FAMILIES.map(({ familyKey }) => {
            const op = database.operations.find((o) => o.idempotency_key === `ifc4x3-triplet-activation:1.1.0:${familyKey}`)!;
            return [familyKey, op.previous_artifact_id];
        })
    );
    for (const { familyKey } of FAMILIES) {
        const family = database.families.find((f) => f.family_key === familyKey)!;
        const trueSource = database.artifacts.find((a) => a.family_id === family.id && a.semantic_version === "1.0.0")!;
        assert.equal(originalPredecessors.get(familyKey), trueSource.id, `${familyKey}: first activation must record the true source`);
    }
    const opUuidsBefore = database.operations.map((o) => o.operation_uuid).sort();

    // Re-invoke while the full triplet is already on target.
    const second = await service.activateGovernedTargetSet();
    assert.equal(second.status, "already_active");

    const opUuidsAfter = database.operations.map((o) => o.operation_uuid).sort();
    assert.deepEqual(opUuidsAfter, opUuidsBefore, "no new operation rows on a no-op rerun");

    for (const { familyKey } of FAMILIES) {
        const op = database.operations.find((o) => o.idempotency_key === `ifc4x3-triplet-activation:1.1.0:${familyKey}`)!;
        assert.equal(op.status, "completed");
        assert.equal(op.previous_artifact_id, originalPredecessors.get(familyKey), `${familyKey}: no-op rerun must not rewrite previous_artifact_id`);
    }
});
