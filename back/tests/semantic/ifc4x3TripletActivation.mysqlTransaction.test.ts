/**
 * Change B — real-transaction atomicity/locking proof.
 *
 * These tests do NOT touch the local operational MySQL database (`digital_twin`)
 * or any live server. They drive the ACTUAL `SemanticArtifactDatabase.activateArtifactSet`
 * SQL through the repository's existing fake mysql2 pool (`tests/helpers/fakeDb.ts`),
 * which is the same disposable, real-semantics harness already relied on by
 * `tests/concurrency/*.test.ts` (nonModelledRace, reservationRace, withNamedLock):
 * it emulates real InnoDB `SELECT ... FOR UPDATE` row-locking (FIFO queue per
 * table+params key) and real BEGIN/COMMIT/ROLLBACK sequencing on dedicated pool
 * connections — so these tests exercise the genuine transaction boundary and
 * row-lock ordering of the production code, not a re-implemented approximation.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection } from "../helpers/fakeDb.ts";

installFakeMySQL();
const { SemanticArtifactDatabase } = await import("../../utils/semanticArtifactDatabase.ts");

const FAMILY_KEYS = [
    "oswadt-ifc4-model-requirements",
    "oswadt-ifc4-minimal-rdf-mapping",
    "oswadt-model-rdf-structural-shapes",
] as const;

interface FamilyRow { id: number; family_key: string; current_artifact_id: number | null }
interface ArtifactRow {
    id: number; family_id: number; semantic_version: string; storage_mode: string;
    named_graph_uri: string | null; validation_status: string; lifecycle_status: string;
    privacy_classification: string;
}
interface OperationRow { operation_uuid: string; operation_type: string; artifact_id: number; status: string; activated_at: string | null; completed_at: string | null; error_code: string | null; previous_artifact_id: number | null }

function freshStore() {
    const families = new Map<number, FamilyRow>();
    const artifacts = new Map<number, ArtifactRow>();
    const operations = new Map<string, OperationRow>();
    let familyId = 1;
    let artifactId = 1;

    for (const familyKey of FAMILY_KEYS) {
        const fid = familyId++;
        const sourceId = artifactId++;
        const targetId = artifactId++;
        const storageMode = familyKey === "oswadt-model-rdf-structural-shapes" ? "graph_backed" : "file_executed";
        artifacts.set(sourceId, {
            id: sourceId, family_id: fid, semantic_version: "1.0.0", storage_mode: storageMode,
            named_graph_uri: storageMode === "graph_backed" ? `https://example.test/graphs/${familyKey}/1.0.0` : null,
            validation_status: storageMode === "graph_backed" ? "graph_verified" : "file_verified",
            lifecycle_status: "active", privacy_classification: "public_research_artifact",
        });
        artifacts.set(targetId, {
            id: targetId, family_id: fid, semantic_version: "1.1.0", storage_mode: storageMode,
            named_graph_uri: storageMode === "graph_backed" ? `https://example.test/graphs/${familyKey}/1.1.0` : null,
            validation_status: storageMode === "graph_backed" ? "graph_verified" : "file_verified",
            lifecycle_status: "validated", privacy_classification: "public_research_artifact",
        });
        families.set(fid, { id: fid, family_key: familyKey, current_artifact_id: sourceId });
        operations.set(`op-${familyKey}`, { operation_uuid: `op-${familyKey}`, operation_type: "activate_existing", artifact_id: targetId, status: "pending_activation", activated_at: null, completed_at: null, error_code: null, previous_artifact_id: null });
    }
    return { families, artifacts, operations, familyKeyToId: new Map([...families.values()].map((f) => [f.family_key, f.id])) };
}

function itemsFor(store: ReturnType<typeof freshStore>) {
    return FAMILY_KEYS.map((familyKey) => {
        const fid = store.familyKeyToId.get(familyKey)!;
        const target = [...store.artifacts.values()].find((a) => a.family_id === fid && a.semantic_version === "1.1.0")!;
        return { familyKey, targetArtifactId: target.id, expectedSourceVersion: "1.0.0", targetVersion: "1.1.0", operationUuid: `op-${familyKey}` };
    });
}

/**
 * The fake pool (tests/helpers/fakeDb.ts) faithfully emulates BEGIN/COMMIT/ROLLBACK
 * call sequencing and real InnoDB-style `FOR UPDATE` row-lock queuing, but — unlike
 * real InnoDB — it does not itself maintain an undo log for row mutations. To prove
 * "a ROLLBACK genuinely undoes every write issued since BEGIN" against this fake, the
 * router below records a pre-image undo closure for every row it mutates; the test
 * replays that undo stack in reverse whenever the production `withTransaction` call
 * throws (i.e. whenever it reaches ROLLBACK rather than COMMIT). This is a test-level
 * reconstruction of InnoDB's own undo behavior, not something the production code
 * does — the production code issues plain UPDATEs inside BEGIN/COMMIT/ROLLBACK exactly
 * as it would against real MySQL.
 */
function installRouter(store: ReturnType<typeof freshStore>, opts: { failOnUpdateCallIndex?: number; undoStack?: Array<() => void> } = {}) {
    let updateCallCount = 0;
    const undo = opts.undoStack;
    fakeConnection.handler = (sql: string, params?: any) => {
        const s = sql.replace(/\s+/g, " ").trim();

        if (/FROM semantic_artifact_families WHERE family_key = :familyKey/.test(s)) {
            const fid = store.familyKeyToId.get(params.familyKey);
            const row = fid !== undefined ? store.families.get(fid) : undefined;
            return [row ? [{ ...row }] : []];
        }
        if (/FROM semantic_artifacts WHERE id = :artifactId/.test(s)) {
            const row = store.artifacts.get(params.artifactId);
            return [row ? [{ ...row }] : []];
        }
        if (/FROM semantic_artifact_load_operations WHERE operation_uuid = :operationUuid/.test(s)) {
            const row = store.operations.get(params.operationUuid);
            return [row ? [{ ...row }] : []];
        }
        if (/FROM semantic_artifacts WHERE family_id = :familyId AND semantic_version = :expectedSourceVersion/.test(s)) {
            const row = [...store.artifacts.values()].find((a) => a.family_id === params.familyId && a.semantic_version === params.expectedSourceVersion);
            return [row ? [{ ...row }] : []];
        }
        if (/UPDATE semantic_artifacts\s*SET lifecycle_status = 'superseded'/.test(s)) {
            updateCallCount++;
            if (opts.failOnUpdateCallIndex === updateCallCount) throw new Error("injected failure before commit");
            const row = store.artifacts.get(params.previous);
            if (row && row.lifecycle_status === "active") {
                const prior = row.lifecycle_status;
                undo?.push(() => { row.lifecycle_status = prior; });
                row.lifecycle_status = "superseded";
            }
            return [{ affectedRows: row ? 1 : 0 }];
        }
        if (/UPDATE semantic_artifacts\s*SET lifecycle_status = 'active'/.test(s)) {
            updateCallCount++;
            if (opts.failOnUpdateCallIndex === updateCallCount) throw new Error("injected failure before commit");
            const row = store.artifacts.get(params.artifactId);
            if (row) {
                const prior = row.lifecycle_status;
                undo?.push(() => { row.lifecycle_status = prior; });
                row.lifecycle_status = "active";
            }
            return [{ affectedRows: row ? 1 : 0 }];
        }
        if (/UPDATE semantic_artifact_families SET current_artifact_id/.test(s)) {
            updateCallCount++;
            if (opts.failOnUpdateCallIndex === updateCallCount) throw new Error("injected failure before commit");
            const row = store.families.get(params.familyId);
            if (row) {
                const prior = row.current_artifact_id;
                undo?.push(() => { row.current_artifact_id = prior; });
                row.current_artifact_id = params.artifactId;
            }
            return [{ affectedRows: row ? 1 : 0 }];
        }
        if (/UPDATE semantic_artifact_load_operations/.test(s)) {
            updateCallCount++;
            if (opts.failOnUpdateCallIndex === updateCallCount) throw new Error("injected failure before commit");
            const row = store.operations.get(params.operationUuid);
            if (row) {
                const prior = { ...row };
                undo?.push(() => { Object.assign(row, prior); });
                row.status = "completed"; row.activated_at ??= "NOW"; row.completed_at ??= "NOW";
                // Only the write-path completion (applyActivationMutation) binds :previousArtifactId;
                // the already-active/idempotent no-op completion does not, and must never touch this field.
                if (/previous_artifact_id\s*=\s*:previousArtifactId/.test(s)) {
                    row.previous_artifact_id = params.previousArtifactId;
                }
            }
            return [{ affectedRows: row ? 1 : 0 }];
        }
        return [[]];
    };
}

beforeEach(() => {
    fakeConnection.reset();
});

function snapshot(store: ReturnType<typeof freshStore>) {
    return {
        families: [...store.families.values()].map((f) => ({ ...f })),
        artifacts: [...store.artifacts.values()].map((a) => ({ ...a })),
        operations: [...store.operations.values()].map((o) => ({ ...o })),
    };
}

/* 1. full 1.0.0 source → full 1.1.0 target commits all three */
test("real transaction: full source set commits all three family pointers together", async () => {
    const store = freshStore();
    installRouter(store);
    const db = new SemanticArtifactDatabase();

    const result = await db.activateArtifactSet({ items: itemsFor(store) });

    assert.equal(result.status, "activated");
    for (const familyKey of FAMILY_KEYS) {
        const fid = store.familyKeyToId.get(familyKey)!;
        const family = store.families.get(fid)!;
        const target = [...store.artifacts.values()].find((a) => a.family_id === fid && a.semantic_version === "1.1.0")!;
        const source = [...store.artifacts.values()].find((a) => a.family_id === fid && a.semantic_version === "1.0.0")!;
        assert.equal(family.current_artifact_id, target.id, `${familyKey} pointer must move to 1.1.0`);
        assert.equal(target.lifecycle_status, "active");
        assert.equal(source.lifecycle_status, "superseded");
        const op = store.operations.get(`op-${familyKey}`)!;
        assert.equal(op.status, "completed");
        assert.equal(op.previous_artifact_id, source.id, `${familyKey}: completed operation must record the true 1.0.0 predecessor`);
    }
    assert.equal(fakeConnection.transactions.filter((t) => t === "commit").length, 1);
    assert.equal(fakeConnection.transactions.filter((t) => t === "rollback").length, 0);
});

/* 2. inject a failure after one/two internal activation steps but before COMMIT → rollback leaves everything unchanged */
test("real transaction: a mid-operation failure rolls back and leaves every source pointer/lifecycle unchanged", async () => {
    const store = freshStore();
    const before = snapshot(store);
    const undoStack: Array<() => void> = [];
    // Each family's activation issues: [supersede-old, activate-new, family-pointer, operation-complete] = 4 UPDATEs.
    // Fail on the 6th UPDATE overall (the "activate-new" step of the SECOND family alphabetically),
    // i.e. strictly AFTER the first family has already fully written — the case that actually
    // exercises rollback discarding a completed sub-write, not just an untouched one.
    installRouter(store, { failOnUpdateCallIndex: 6, undoStack });
    const db = new SemanticArtifactDatabase();

    await assert.rejects(db.activateArtifactSet({ items: itemsFor(store) }), /injected failure before commit/);
    assert.ok(fakeConnection.transactions.includes("rollback"), "the failed transaction must issue ROLLBACK");
    assert.equal(fakeConnection.transactions.filter((t) => t === "commit").length, 0, "the failed transaction must never commit");

    // The transaction reached ROLLBACK rather than COMMIT (proven above). Replay the
    // undo stack captured during the transaction to reconstruct the pre-image the real
    // InnoDB undo log would have restored, then assert full pre-transaction equality.
    while (undoStack.length) undoStack.pop()!();
    assert.deepEqual(snapshot(store), before, "no family/artifact/operation row may retain a partial write once rolled back");
});

/* 3. partial/mixed source fails with zero mutation (real transaction path, not just the fake port) */
test("real transaction: a mixed source state fails closed via activation_conflict with zero mutation", async () => {
    const store = freshStore();
    // Corrupt one family to already point at its 1.1.0 target — a mixed triplet.
    const mappingFamilyId = store.familyKeyToId.get("oswadt-ifc4-minimal-rdf-mapping")!;
    const mappingTarget = [...store.artifacts.values()].find((a) => a.family_id === mappingFamilyId && a.semantic_version === "1.1.0")!;
    store.families.get(mappingFamilyId)!.current_artifact_id = mappingTarget.id;
    const before = snapshot(store);
    installRouter(store);
    const db = new SemanticArtifactDatabase();

    await assert.rejects(
        db.activateArtifactSet({ items: itemsFor(store) }),
        (error: any) => error?.code === "activation_conflict"
    );

    assert.deepEqual(snapshot(store), before);
    assert.equal(fakeConnection.transactions.filter((t) => t === "commit").length, 0);
});

/* 4. two concurrent triplet activations cannot produce partial state */
test("real transaction: two concurrent triplet activations serialize on the family row locks; no partial state results", async () => {
    const store = freshStore();
    installRouter(store);
    const dbA = new SemanticArtifactDatabase();
    const dbB = new SemanticArtifactDatabase();

    const [a, b] = await Promise.allSettled([
        dbA.activateArtifactSet({ items: itemsFor(store) }),
        dbB.activateArtifactSet({ items: itemsFor(store) }),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const rejected = [a, b].filter((r) => r.status === "rejected");
    // Both may succeed (one "activated", one "already_active" idempotent no-op observing the
    // other's committed write) — what must NEVER happen is a partial/mixed final state.
    assert.equal(rejected.length, 0, `no concurrent triplet activation may fail with a real row-lock queue: ${JSON.stringify(rejected)}`);
    const statuses = fulfilled.map((r) => r.value.status).sort();
    assert.deepEqual(statuses, ["activated", "already_active"], "exactly one writer, one idempotent observer");

    for (const familyKey of FAMILY_KEYS) {
        const fid = store.familyKeyToId.get(familyKey)!;
        const family = store.families.get(fid)!;
        const target = [...store.artifacts.values()].find((a) => a.family_id === fid && a.semantic_version === "1.1.0")!;
        const source = [...store.artifacts.values()].find((a) => a.family_id === fid && a.semantic_version === "1.0.0")!;
        assert.equal(family.current_artifact_id, target.id, `${familyKey} must end fully on 1.1.0, never a mix`);
        // Persisted provenance must be truthful and identical regardless of which of the two
        // concurrent callers actually performed the write vs idempotently observed it.
        const op = store.operations.get(`op-${familyKey}`)!;
        assert.equal(op.status, "completed");
        assert.equal(op.previous_artifact_id, source.id, `${familyKey}: concurrent activation must still record the true 1.0.0 predecessor`);
    }
});
