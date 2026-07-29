/**
 * ADR-0051 §1/§2-v4 — explicit acquisition/release semantics of withNamedLock.
 *
 * The Stage 0B linked_model Reference lock depends on these exact semantics:
 *  - GET_LOCK=1 required; =0 → lock_timeout (nothing held → connection RETURNED, or
 *    DESTROYED if release() itself fails, timeout still the primary result);
 *  - GET_LOCK query-throw or NULL → the acquisition outcome is UNKNOWN, so the
 *    dedicated connection is DESTROYED (never pooled) and a DISTINCT lock_error is
 *    raised — the callback never runs;
 *  - RELEASE_LOCK=1 required; 0/NULL/throw, or a failing release()/close, → the
 *    dedicated connection is DESTROYED and the result is lock_release_failed;
 *  - a callback error is ALWAYS the primary error and is NEVER replaced by a release
 *    error; a non-Error throwable is normalized to a stable Error (original as `cause`);
 *    a simultaneous release failure attaches lockReleaseFailed / lockReleaseErrorCode.
 *
 * Every case requires the EXACT stable ConcurrencyError code — never "a raw driver
 * error OR a typed error". A controllable pool/connection stub is injected onto the
 * MySQLDatabase instance so the acquire/release results and the release/destroy calls
 * are observed directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL } from "../helpers/fakeDb.ts";

installFakeMySQL(); // env vars so `new MySQLDatabase()` constructs
const { default: MySQLDatabase } = await import("../../utils/mysqlDatabase.ts");

interface StubOpts {
    acquire?: 0 | 1 | null;          // GET_LOCK result
    acquireThrows?: boolean;         // GET_LOCK query itself throws
    release?: 0 | 1 | null;          // RELEASE_LOCK result
    releaseQueryThrows?: boolean;    // RELEASE_LOCK query throws
    releaseCloseThrows?: boolean;    // conn.release() throws
    destroyThrows?: boolean;         // conn.destroy() throws
}

function makeDb(opts: StubOpts) {
    const conn = {
        released: false, destroyed: false, queries: [] as string[],
        async query(sql: string) {
            conn.queries.push(sql);
            if (/GET_LOCK/i.test(sql)) {
                if (opts.acquireThrows) throw new Error("acquire boom");
                return [[{ acquired: opts.acquire === undefined ? 1 : opts.acquire }]];
            }
            if (/RELEASE_LOCK/i.test(sql)) {
                if (opts.releaseQueryThrows) throw new Error("release query boom");
                return [[{ released: opts.release === undefined ? 1 : opts.release }]];
            }
            return [[]];
        },
        release() { conn.released = true; if (opts.releaseCloseThrows) throw new Error("release() close boom"); },
        destroy() { conn.destroyed = true; if (opts.destroyThrows) throw new Error("destroy boom"); },
    };
    const db: any = new MySQLDatabase();
    db.pool = { getConnection: async () => conn }; // bypass the real pool
    return { db, conn };
}

const isConc = (name: string, code: string) => (e: any) => e.name === "ConcurrencyError" && e.code === code;

/* -------------------------------- acquisition -------------------------------- */

test("GET_LOCK query throws → lock_error (unknown outcome); connection DESTROYED, not pooled; callback never runs", async () => {
    const { db, conn } = makeDb({ acquireThrows: true });
    let ran = false;
    await assert.rejects(db.withNamedLock("n", 1, async () => { ran = true; }), isConc("ConcurrencyError", "lock_error"));
    assert.equal(ran, false, "callback never runs on a failed acquisition");
    assert.equal(conn.destroyed, true, "unknown acquisition outcome → session destroyed");
    assert.equal(conn.released, false, "a possibly-locked session is never returned to the pool");
});

test("GET_LOCK NULL → lock_error, distinct from timeout; connection DESTROYED; callback never runs", async () => {
    const { db, conn } = makeDb({ acquire: null });
    let ran = false;
    await assert.rejects(db.withNamedLock("n", 1, async () => { ran = true; }), isConc("ConcurrencyError", "lock_error"));
    assert.equal(ran, false);
    assert.equal(conn.destroyed, true);
    assert.equal(conn.released, false);
});

test("acquisition timeout (GET_LOCK=0) → lock_timeout; connection RETURNED; callback never runs", async () => {
    const { db, conn } = makeDb({ acquire: 0 });
    let ran = false;
    await assert.rejects(db.withNamedLock("n", 1, async () => { ran = true; }), isConc("ConcurrencyError", "lock_timeout"));
    assert.equal(ran, false);
    assert.equal(conn.released, true, "nothing was held, so the connection is reused");
    assert.equal(conn.destroyed, false);
});

test("timeout with a failing release() → lock_timeout stays primary; connection DESTROYED", async () => {
    const { db, conn } = makeDb({ acquire: 0, releaseCloseThrows: true });
    await assert.rejects(db.withNamedLock("n", 1, async () => {}), isConc("ConcurrencyError", "lock_timeout"));
    assert.equal(conn.destroyed, true, "release() failed after a timeout → destroy (always released OR destroyed)");
});

/* --------------------------------- happy path -------------------------------- */

test("happy path: callback runs, RELEASE_LOCK=1, connection released (not destroyed)", async () => {
    const { db, conn } = makeDb({ acquire: 1, release: 1 });
    const out = await db.withNamedLock("n", 1, async () => "value");
    assert.equal(out, "value");
    assert.equal(conn.released, true);
    assert.equal(conn.destroyed, false);
});

/* --------------------- callback-error preservation & normalization ----------- */

test("callback failure + successful release → original callback error preserved, no lockReleaseFailed", async () => {
    const { db, conn } = makeDb({ acquire: 1, release: 1 });
    const boom = new Error("callback boom");
    await assert.rejects(db.withNamedLock("n", 1, async () => { throw boom; }),
        (e: any) => e === boom && e.lockReleaseFailed === undefined);
    assert.equal(conn.released, true);
    assert.equal(conn.destroyed, false);
});

test("non-Error callback throwable is normalized to a stable Error (original preserved as cause)", async () => {
    const { db } = makeDb({ acquire: 1, release: 1 });
    await assert.rejects(db.withNamedLock("n", 1, async () => { throw "string boom"; }),
        (e: any) => e instanceof Error && /string boom/.test(e.message) && e.cause === "string boom");
});

test("callback failure + release failure → callback error preserved with structured lock-release metadata; connection destroyed", async () => {
    const { db, conn } = makeDb({ acquire: 1, release: 0 });
    const boom = new Error("callback boom");
    await assert.rejects(db.withNamedLock("n", 1, async () => { throw boom; }),
        (e: any) => e === boom && e.lockReleaseFailed === true && e.lockReleaseErrorCode === "lock_release_failed"
            && typeof e.lockReleaseMessage === "string");
    assert.equal(conn.destroyed, true, "lock may still be held → session destroyed");
    assert.equal(conn.released, false);
});

test("non-Error callback throwable + release failure → normalized Error still carries lockReleaseFailed", async () => {
    const { db, conn } = makeDb({ acquire: 1, release: 0 });
    await assert.rejects(db.withNamedLock("n", 1, async () => { throw 42; }),
        (e: any) => e instanceof Error && (e as any).cause === 42 && (e as any).lockReleaseFailed === true
            && (e as any).lockReleaseErrorCode === "lock_release_failed");
    assert.equal(conn.destroyed, true);
});

/* ---------------------- callback success + release failure ------------------- */

test("callback success + RELEASE_LOCK=0 → lock_release_failed thrown; connection destroyed", async () => {
    const { db, conn } = makeDb({ acquire: 1, release: 0 });
    await assert.rejects(db.withNamedLock("n", 1, async () => "ok"), isConc("ConcurrencyError", "lock_release_failed"));
    assert.equal(conn.destroyed, true);
    assert.equal(conn.released, false);
});

test("callback success + RELEASE_LOCK NULL → lock_release_failed; connection destroyed", async () => {
    const { db, conn } = makeDb({ acquire: 1, release: null });
    await assert.rejects(db.withNamedLock("n", 1, async () => "ok"), isConc("ConcurrencyError", "lock_release_failed"));
    assert.equal(conn.destroyed, true);
});

test("callback success + RELEASE_LOCK query throws → lock_release_failed (exact code); connection destroyed", async () => {
    const { db, conn } = makeDb({ acquire: 1, releaseQueryThrows: true });
    await assert.rejects(db.withNamedLock("n", 1, async () => "ok"), isConc("ConcurrencyError", "lock_release_failed"));
    assert.equal(conn.destroyed, true);
});

test("connection-close failure (release() throws) after a confirmed RELEASE_LOCK → lock_release_failed; destroyed", async () => {
    const { db, conn } = makeDb({ acquire: 1, release: 1, releaseCloseThrows: true });
    await assert.rejects(db.withNamedLock("n", 1, async () => "ok"), isConc("ConcurrencyError", "lock_release_failed"));
    assert.equal(conn.destroyed, true, "always released OR destroyed");
});

test("destroy failure after a release failure is reported, not silently ignored (lockConnectionDestroyFailed)", async () => {
    const { db, conn } = makeDb({ acquire: 1, release: 0, destroyThrows: true });
    await assert.rejects(db.withNamedLock("n", 1, async () => "ok"),
        (e: any) => e.code === "lock_release_failed" && e.lockConnectionDestroyFailed === true);
    assert.equal(conn.destroyed, true, "destroy was attempted even though it failed");
});
