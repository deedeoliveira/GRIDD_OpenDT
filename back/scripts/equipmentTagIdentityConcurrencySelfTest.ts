/**
 * Disposable-schema self-test for TAG-1 (IfcElement.Tag as the portfolio-wide
 * persistent-identity key) — the CONCURRENCY proof:
 *   back/utils/persistentAssetDatabase.ts — withEquipmentTagIdentityLock,
 *     equipmentTagIdentityLockName, findEquipmentByTag, createAsset
 *   back/classification/equipmentTag.ts   — canonicalEquipmentTagKey
 *   back/utils/mysqlDatabase.ts           — withNamedLock (GET_LOCK/RELEASE_LOCK)
 *
 * Follows exactly the safety pattern of scripts/ifc4x3TripletActivationSelfTest.ts and
 * scripts/semanticExecutionContextSelfTest.ts: a brand-new throwaway schema is created on
 * the configured MySQL SERVER (NEVER the operational database named by DB_NAME /
 * `digital_twin`), the `assets` table is built from the columns the real migrations
 * define (2026-07-17_asset_identity.sql + 2026-07-17_equipment_tag_serial.sql), and the
 * REAL production methods are exercised against genuine mysql2 connections and real
 * server-side named locks — never a mock. The disposable schema is ALWAYS dropped; the
 * operational database is never selected or modified. The DB password is read from .env
 * exactly as the Change B/C scripts do and is never logged.
 *
 * SCOPE NOTE (honest): the first-seen sequence exercised here — acquire the per-canonical-Tag
 * lock, re-read by canonical Tag, create only if still absent — is composed in this script
 * in the SAME order that back/services/assetInventoryService.ts composes it. The three
 * primitives it composes (withEquipmentTagIdentityLock, findEquipmentByTag, createAsset)
 * are the REAL production methods, unmocked. Building the full asset_bindings/entities/
 * model_versions FK graph that persistAssetsForVersion additionally requires would not
 * strengthen the race proof, which is entirely about those three primitives.
 *
 * Usage (safe): npx tsx scripts/equipmentTagIdentityConcurrencySelfTest.ts
 */
import "dotenv/config";
import mysql from "mysql2/promise";

let failures = 0;
let passes = 0;
function check(name: string, condition: boolean, detail = ""): void {
    if (condition) { passes += 1; console.log(`    PASS  ${name}`); }
    else { failures += 1; console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
async function scalar(conn: mysql.Connection, sql: string, params: any[] = []): Promise<any> {
    const [rows]: any = await conn.query(sql, params);
    const row = rows[0] ?? {};
    return row[Object.keys(row)[0] as string];
}
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The `assets` columns that TAG-1 actually reads/writes, exactly as the real migrations
 * define them (2026-07-17_asset_identity.sql adds asset_uuid/asset_code/linked_model_id/
 * source/lifecycle_status/...; 2026-07-17_equipment_tag_serial.sql adds serial_number).
 * The FKs to spaces/linked_models are intentionally omitted: TAG-1 changes no FK and the
 * race is entirely within the `assets` row set.
 */
async function buildAssetsTable(conn: mysql.Connection): Promise<void> {
    await conn.query(`CREATE TABLE \`assets\` (
        \`id\` INT NOT NULL AUTO_INCREMENT,
        \`name\` VARCHAR(255) NOT NULL,
        \`asset_type\` VARCHAR(50) NOT NULL,
        \`reservable\` TINYINT(1) NOT NULL DEFAULT 1,
        \`model_version_id\` INT NULL,
        \`asset_uuid\` CHAR(36) NULL,
        \`asset_code\` VARCHAR(200) NULL,
        \`serial_number\` VARCHAR(255) NULL,
        \`semantic_uri\` VARCHAR(500) NULL,
        \`space_id\` INT NULL,
        \`linked_model_id\` INT NULL,
        \`source\` VARCHAR(50) NOT NULL DEFAULT 'ifc',
        \`lifecycle_status\` ENUM('active','absent','pending_reconciliation','retired') NOT NULL DEFAULT 'active',
        \`created_at\` DATETIME DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        \`retired_at\` DATETIME NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_assets_uuid\` (\`asset_uuid\`),
        KEY \`idx_assets_scope_code\` (\`linked_model_id\`, \`asset_code\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
}

async function main(): Promise<void> {
    const operationalDb = process.env.DB_NAME;
    const schema = `oswadt_tag_identity_selftest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    if (schema === operationalDb || schema === "digital_twin") throw new Error("refusing to reuse the operational database name");
    const baseConfig = {
        host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
        user: process.env.DB_USER, password: process.env.DB_PASSWORD, multipleStatements: false,
    } as any;

    const server = await mysql.createConnection(baseConfig);
    const [[versionRow]]: any = await server.query(
        "SELECT VERSION() AS v, @@GLOBAL.transaction_isolation AS iso");
    console.log(JSON.stringify({
        event: "tag_identity_concurrency_selftest_start",
        disposableSchema: schema, operationalDatabase: operationalDb,
        mysqlVersion: versionRow.v, isolationLevel: versionRow.iso,
        note: "operational database is never selected or modified",
    }));

    await server.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const conn = await mysql.createConnection({ ...baseConfig, database: schema } as any);

    // Point the PRODUCTION classes at the disposable schema before importing them.
    process.env.DB_NAME = schema;
    const assetDbModule = await import("../utils/persistentAssetDatabase.ts");
    const assetDb: any = assetDbModule.default;
    const { equipmentTagIdentityLockName } = assetDbModule;
    const { canonicalEquipmentTagKey } = await import("../classification/equipmentTag.ts");
    const MySQLDatabase = (await import("../utils/mysqlDatabase.ts")).default;

    /**
     * The first-seen identity decision, composed exactly as assetInventoryService does:
     * the ENTIRE lookup→create sequence runs inside the per-canonical-Tag lock.
     */
    async function firstSeenIdentity(rawTag: string, linkedModelId: number,
        opts: { failMidCreation?: boolean; onInside?: () => Promise<void> } = {},
    ): Promise<{ outcome: "created" | "reused"; assetId: number }> {
        const canonicalTag = canonicalEquipmentTagKey(rawTag);
        return assetDb.withEquipmentTagIdentityLock(canonicalTag, async () => {
            const matches = await assetDb.findEquipmentByTag(canonicalTag);
            if (opts.onInside) await opts.onInside();
            if (matches.length === 1) return { outcome: "reused" as const, assetId: Number(matches[0].id) };
            if (matches.length > 1) throw new Error(`ambiguous: ${matches.length} assets share the canonical Tag`);
            if (opts.failMidCreation) throw new Error("injected failure mid-creation");
            const created = await assetDb.createAsset({
                name: rawTag, assetType: "equipment", assetCode: rawTag.trim(),
                serialNumber: null, linkedModelId, reservable: true,
            });
            return { outcome: "created" as const, assetId: Number(created.assetId) };
        });
    }

    const countFor = async (canonicalTag: string): Promise<number> => Number(await scalar(conn,
        "SELECT COUNT(*) AS c FROM assets WHERE UPPER(TRIM(asset_code)) = ? AND asset_type = 'equipment'", [canonicalTag]));

    try {
        await buildAssetsTable(conn);
        console.log(`  storage engine: ${await scalar(conn, `SELECT ENGINE FROM information_schema.tables WHERE table_schema=? AND table_name='assets'`, [schema])}`);
        console.log(`  session isolation: ${await scalar(conn, `SELECT @@SESSION.transaction_isolation`)}`);
        console.log(`  selected database on a production-class connection: ${schema}`);

        // ---- TEST 1: same canonical Tag, SAME model context, two concurrent first-seens ----
        console.log("  [1] real MySQL: 2 concurrent first-seen candidates, same Tag, same linked_model");
        {
            const tag = "EQP-RACE-1";
            const [a, b] = await Promise.all([firstSeenIdentity(tag, 10), firstSeenIdentity(tag, 10)]);
            const outcomes = [a.outcome, b.outcome].sort();
            check("1.1 exactly one connection created and the other reused",
                outcomes[0] === "created" && outcomes[1] === "reused", outcomes.join("/"));
            check("1.2 both resolved to the SAME persistent asset id", a.assetId === b.assetId,
                `${a.assetId} vs ${b.assetId}`);
            check("1.3 direct SQL: exactly ONE asset row for the canonical Tag",
                await countFor(canonicalEquipmentTagKey(tag)) === 1, `${await countFor(canonicalEquipmentTagKey(tag))} rows`);
        }

        // ---- TEST 2: same canonical Tag from DIFFERENT linked-model contexts ----
        console.log("  [2] real MySQL: same Tag raced from DIFFERENT linked_model contexts");
        {
            const tag = "EQP-RACE-2";
            const [a, b] = await Promise.all([firstSeenIdentity(tag, 10), firstSeenIdentity(tag, 99)]);
            check("2.1 exactly one created, one reused across different linked_models",
                [a.outcome, b.outcome].sort().join("/") === "created/reused", `${a.outcome}/${b.outcome}`);
            check("2.2 both resolved to the SAME persistent asset id", a.assetId === b.assetId,
                `${a.assetId} vs ${b.assetId}`);
            const rows = Number(await countFor(canonicalEquipmentTagKey(tag)));
            check("2.3 direct SQL: still exactly ONE asset row (portfolio-wide identity)", rows === 1, `${rows} rows`);
            const origin = await scalar(conn, "SELECT linked_model_id FROM assets WHERE UPPER(TRIM(asset_code)) = ?",
                [canonicalEquipmentTagKey(tag)]);
            check("2.4 linked_model_id keeps the CREATING context (origin metadata, never rewritten)",
                origin === 10 || origin === 99, String(origin));
        }

        // ---- TEST 3: canonical-EQUIVALENT tags (case/whitespace) racing ----
        console.log("  [3] real MySQL: canonical-equivalent Tags (case/whitespace) raced concurrently");
        {
            const variants = ["EQP-RACE-3abc", "  EQP-RACE-3ABC  ", "EQP-RACE-3AbC"];
            const canonical = canonicalEquipmentTagKey(variants[0]!);
            const results = await Promise.all(variants.map((v) => firstSeenIdentity(v, 10)));
            const created = results.filter((r) => r.outcome === "created").length;
            check("3.1 exactly ONE of the three canonical-equivalent variants created an identity",
                created === 1, `${created} creations`);
            check("3.2 all three resolved to the same persistent asset id",
                new Set(results.map((r) => r.assetId)).size === 1, JSON.stringify(results.map((r) => r.assetId)));
            const rows = await countFor(canonical);
            check("3.3 direct SQL: exactly ONE asset row — the CANONICAL rule governed the race, not raw string equality",
                rows === 1, `${rows} rows`);
        }

        /* ---- TEST 3b (TAG-1 V2, correction A): the WIDENED candidate retrieval ----
           V2 removed the `UPPER(TRIM(asset_code)) = :canonicalTag` SQL prefilter,
           because MySQL's UPPER() and JavaScript's toUpperCase() are not equivalent
           over Unicode: retrieval now returns the equipment DOMAIN and the canonical
           JS function is the sole authority. Two things must hold under REAL
           concurrency against REAL MySQL:
             (a) a canonical-equivalent pair that the OLD SQL prefilter would have
                 missed ('EQP-straße' vs 'EQP-STRASSE' — JS expands ß→SS, MySQL does
                 not) still collapses to exactly ONE persistent asset;
             (b) the broad retrieval, with unrelated rows already in the table, does
                 not over-match: unrelated Tags keep their own identities. */
        console.log("  [3b] real MySQL: Unicode canonical-equivalent race under the WIDENED candidate retrieval");
        {
            const variants = ["EQP-straße", "EQP-STRASSE", "  eqp-strasse  "];
            const canonical = canonicalEquipmentTagKey(variants[0]!);
            check("3b.0 precondition: JS canonicalises all three variants identically",
                variants.every((v) => canonicalEquipmentTagKey(v) === canonical), canonical);

            // The old SQL prefilter really would have split this identity.
            const upperInMysql = String(await scalar(conn, "SELECT UPPER(?) AS u", ["EQP-straße"]));
            check("3b.1 MySQL's UPPER() does NOT agree with the canonical function (the V1 false negative)",
                upperInMysql !== canonical, `MySQL UPPER='${upperInMysql}' vs canonical='${canonical}'`);

            const results = await Promise.all(variants.map((v) => firstSeenIdentity(v, 10)));
            const created = results.filter((r) => r.outcome === "created").length;
            check("3b.2 exactly ONE identity created despite the Unicode case expansion", created === 1,
                `${created} creations`);
            check("3b.3 all variants resolved to the same persistent asset id",
                new Set(results.map((r) => r.assetId)).size === 1, JSON.stringify(results.map((r) => r.assetId)));

            // Count via the PRODUCTION retrieval — a raw UPPER(TRIM()) count would
            // itself be subject to the very defect this test is about.
            const viaProduction = await assetDb.findEquipmentByTag(canonical);
            check("3b.4 the production retrieval finds exactly ONE row for the canonical Tag",
                viaProduction.length === 1, `${viaProduction.length} rows`);

            // (b) the broad retrieval must not over-match rows already in the table.
            const unrelated = await assetDb.findEquipmentByTag(canonicalEquipmentTagKey("EQP-RACE-1"));
            check("3b.5 the widened retrieval does NOT over-match unrelated Tags already present",
                unrelated.length === 1 && !viaProduction.some((r: any) => r.id === unrelated[0].id),
                `${unrelated.length} rows`);
        }

        // ---- TEST 4: the lock is released after a SUCCESSFUL creation ----
        console.log("  [4] real MySQL: lock released after success (independent acquisition succeeds promptly)");
        {
            const tag = "EQP-RELEASE-OK";
            await firstSeenIdentity(tag, 10);
            const lockName = equipmentTagIdentityLockName(schema, canonicalEquipmentTagKey(tag));
            const probe = await mysql.createConnection({ ...baseConfig, database: schema } as any);
            const started = Date.now();
            const acquired = Number(await scalar(probe, "SELECT GET_LOCK(?, 2) AS a", [lockName]));
            const elapsed = Date.now() - started;
            await probe.query("SELECT RELEASE_LOCK(?)", [lockName]);
            await probe.end();
            check("4.1 an independent connection acquires the same lock after success", acquired === 1, `GET_LOCK=${acquired}`);
            check("4.2 it acquires PROMPTLY (not after a timeout)", elapsed < 1000, `${elapsed} ms`);
        }

        // ---- TEST 5: the lock is released after a REAL injected failure mid-creation ----
        console.log("  [5] real MySQL: lock released after an injected failure inside the critical section");
        {
            const tag = "EQP-RELEASE-FAIL";
            const canonical = canonicalEquipmentTagKey(tag);
            let threw = false;
            try { await firstSeenIdentity(tag, 10, { failMidCreation: true }); }
            catch { threw = true; }
            check("5.1 the injected failure propagated (never swallowed)", threw);
            check("5.2 no partial identity was created by the failed attempt",
                await countFor(canonical) === 0, `${await countFor(canonical)} rows`);

            const lockName = equipmentTagIdentityLockName(schema, canonical);
            const probe = await mysql.createConnection({ ...baseConfig, database: schema } as any);
            const started = Date.now();
            const acquired = Number(await scalar(probe, "SELECT GET_LOCK(?, 2) AS a", [lockName]));
            const elapsed = Date.now() - started;
            await probe.query("SELECT RELEASE_LOCK(?)", [lockName]);
            await probe.end();
            check("5.3 the lock was released despite the failure", acquired === 1, `GET_LOCK=${acquired}`);
            check("5.4 released promptly (finally-path, not a server-side expiry)", elapsed < 1000, `${elapsed} ms`);

            // the Tag is still usable afterwards — the failure left nothing stuck
            const after = await firstSeenIdentity(tag, 10);
            check("5.5 the same Tag is still creatable after the failed attempt", after.outcome === "created");
        }

        // ---- TEST 6: bounded wait + FAIL CLOSED when another session holds the lock ----
        console.log("  [6] real MySQL: bounded timeout fails CLOSED while another connection holds the lock");
        {
            const canonical = canonicalEquipmentTagKey("EQP-CONTENDED");
            const lockName = equipmentTagIdentityLockName(schema, canonical);
            const holder = await mysql.createConnection({ ...baseConfig, database: schema } as any);
            const held = Number(await scalar(holder, "SELECT GET_LOCK(?, 5) AS a", [lockName]));
            check("6.1 an independent connection holds the identity lock", held === 1);

            // The REAL production helper, with a deliberately short bound so the test is fast.
            // Production uses the same helper with a 30s bound.
            const db = new (MySQLDatabase as any)();
            db.connect();
            let code = "";
            let bodyRan = false;
            const started = Date.now();
            try {
                await db.withNamedLock(lockName, 1, async () => { bodyRan = true; });
            } catch (e: any) { code = e?.code ?? String(e); }
            const elapsed = Date.now() - started;

            check("6.2 acquisition FAILED CLOSED with a typed lock_timeout", code === "lock_timeout", code || "(no error)");
            check("6.3 the critical section NEVER ran unprotected", bodyRan === false);
            check("6.4 the wait was BOUNDED (~1s, not indefinite)", elapsed >= 900 && elapsed < 5000, `${elapsed} ms`);

            await holder.query("SELECT RELEASE_LOCK(?)", [lockName]);
            await holder.end();

            const after = Number(await scalar(conn, "SELECT IS_FREE_LOCK(?) AS f", [lockName]));
            check("6.5 the lock is free again once the holder releases it", after === 1, `IS_FREE_LOCK=${after}`);
        }

        // ---- TEST 7: high-contention race on one Tag -> still exactly one identity ----
        console.log("  [7] real MySQL: 8-way concurrent race on a single canonical Tag");
        {
            const tag = "EQP-RACE-8WAY";
            const canonical = canonicalEquipmentTagKey(tag);
            const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
                firstSeenIdentity(i % 2 === 0 ? tag : `  ${tag.toLowerCase().replace("eqp-", "EQP-")}  `, 10 + i,
                    { onInside: () => sleep(Math.floor(Math.random() * 8)) })));
            const created = results.filter((r) => r.outcome === "created").length;
            check("7.1 exactly ONE creation across 8 concurrent contenders", created === 1, `${created} creations`);
            check("7.2 all 8 resolved to the same persistent asset id",
                new Set(results.map((r) => r.assetId)).size === 1, JSON.stringify([...new Set(results.map((r) => r.assetId))]));
            const rows = await countFor(canonical);
            check("7.3 direct SQL: exactly ONE asset row for the canonical Tag", rows === 1, `${rows} rows`);
        }

        // ---- TEST 8: different Tags are NOT serialised against each other ----
        console.log("  [8] real MySQL: different canonical Tags stay independently processable");
        {
            const a = equipmentTagIdentityLockName(schema, "EQP-INDEP-A");
            const b = equipmentTagIdentityLockName(schema, "EQP-INDEP-B");
            check("8.1 distinct Tags produce distinct lock names", a !== b);
            check("8.2 lock names stay within MySQL's 64-character GET_LOCK limit",
                a.length < 64 && equipmentTagIdentityLockName(schema, "EQP-" + "X".repeat(4000)).length < 64,
                `${a.length} chars`);

            const holder = await mysql.createConnection({ ...baseConfig, database: schema } as any);
            await holder.query("SELECT GET_LOCK(?, 5)", [a]);
            const started = Date.now();
            const other = await firstSeenIdentity("EQP-INDEP-B", 10);
            const elapsed = Date.now() - started;
            await holder.query("SELECT RELEASE_LOCK(?)", [a]);
            await holder.end();
            check("8.3 a held lock on Tag A does not block Tag B", other.outcome === "created");
            check("8.4 Tag B proceeded without waiting", elapsed < 1000, `${elapsed} ms`);
        }

        // ---- TEST 9: the operational database was never touched ----
        console.log("  [9] safety: the operational database was never selected or written");
        {
            const selected = await scalar(conn, "SELECT DATABASE() AS db");
            check("9.1 the working connection is on the disposable schema", selected === schema, String(selected));
            check("9.2 the disposable schema is not the operational database",
                schema !== operationalDb && schema !== "digital_twin");
            const totalRows = Number(await scalar(conn, "SELECT COUNT(*) AS c FROM assets"));
            console.log(`    assets rows created in the disposable schema: ${totalRows}`);
        }
    } finally {
        await conn.end();
        await server.query(`DROP DATABASE \`${schema}\``);
        const [stillExists]: any = await server.query(
            `SELECT SCHEMA_NAME FROM information_schema.schemata WHERE SCHEMA_NAME=?`, [schema]);
        const [operationalStillExists]: any = await server.query(
            `SELECT SCHEMA_NAME FROM information_schema.schemata WHERE SCHEMA_NAME=?`, [operationalDb]);
        console.log(JSON.stringify({
            event: "tag_identity_concurrency_selftest_end",
            disposableSchemaDropped: schema, disposableSchemaStillExists: stillExists.length > 0,
            operationalDatabaseStillExists: operationalStillExists.length > 0,
            passes, failures,
        }));
        await server.end();
    }
    // The production classes opened their own mysql2 pools against the (now dropped)
    // disposable schema; exit explicitly so those pools cannot keep the process alive.
    process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
