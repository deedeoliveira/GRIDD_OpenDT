/**
 * Disposable-schema self-test for Change C (coherent pinned semantic execution context):
 *   back/utils/semanticArtifactDatabase.ts — resolveCurrentArtifactSet (the single-statement
 *     LEFT JOIN snapshot of the three governed current pointers)
 *   back/modelIntake/semanticExecutionContext.ts — buildSemanticExecutionContext
 *
 * Follows exactly the safety pattern of scripts/ifc4x3TripletActivationSelfTest.ts: it
 * creates a brand-new throwaway schema on the configured MySQL SERVER (NEVER the
 * operational database named by DB_NAME / `digital_twin`), builds a faithful subset of the
 * real semantic-artifact registry schema from the migration files
 * (2026-07-20_semantic_artifact_registry.sql base tables, plus the verbatim ALTERs from
 * 2026-07-20_ids_validation.sql and 2026-07-21_semantic_reservation_evidence.sql; every
 * other CREATE TABLE in those files is intentionally omitted because Change C does not
 * touch those tables), seeds through the REAL `SemanticArtifactDatabase` methods, and then
 * exercises the REAL production snapshot query and the REAL context builder — never a
 * mock — against genuine mysql2 connections and real InnoDB transactions. The disposable
 * schema is ALWAYS dropped; the operational database is never selected or modified. The DB
 * password is read from .env exactly as the Change B script does and is never logged.
 *
 * Usage (safe): npx tsx scripts/semanticExecutionContextSelfTest.ts
 */
import "dotenv/config";
import crypto from "node:crypto";
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

const IDS_FAMILY = "oswadt-ifc4-model-requirements";
const MAPPING_FAMILY = "oswadt-ifc4-minimal-rdf-mapping";
const SHAPES_FAMILY = "oswadt-model-rdf-structural-shapes";
const FAMILY_KEYS = [IDS_FAMILY, MAPPING_FAMILY, SHAPES_FAMILY] as const;
const SOURCE_VERSION = "1.0.0";
const TARGET_VERSION = "1.1.0";

/** Base tables verbatim from database/migrations/2026-07-20_semantic_artifact_registry.sql. */
async function buildBaseSchema(conn: mysql.Connection): Promise<void> {
    await conn.query(`CREATE TABLE \`semantic_artifact_families\` (
        \`id\` BIGINT NOT NULL AUTO_INCREMENT,
        \`family_uuid\` CHAR(36) NOT NULL,
        \`artifact_type\` ENUM('ontology','bridge_vocabulary','shacl_shapes','institutional_dataset','test_fixture','ids_profile','ifc_rdf_mapping','validation_report') NOT NULL,
        \`family_key\` VARCHAR(200) NOT NULL,
        \`name\` VARCHAR(300) NOT NULL,
        \`semantic_uri\` VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NULL,
        \`privacy_policy\` ENUM('public_research_artifact','synthetic_runtime_data','synthetic_test_only','private_local','requires_manual_review') NOT NULL,
        \`current_artifact_id\` BIGINT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_semantic_family_uuid\` (\`family_uuid\`),
        UNIQUE KEY \`uq_semantic_family_key\` (\`family_key\`),
        UNIQUE KEY \`uq_semantic_family_type_uri\` (\`artifact_type\`, \`semantic_uri\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await conn.query(`CREATE TABLE \`semantic_artifacts\` (
        \`id\` BIGINT NOT NULL AUTO_INCREMENT,
        \`artifact_uuid\` CHAR(36) NOT NULL,
        \`family_id\` BIGINT NOT NULL,
        \`semantic_version\` VARCHAR(100) NOT NULL,
        \`source_filename\` VARCHAR(500) NOT NULL,
        \`repository_relative_path\` VARCHAR(1000) NOT NULL,
        \`byte_size\` BIGINT NOT NULL,
        \`sha256\` CHAR(64) NOT NULL,
        \`media_type\` VARCHAR(100) NOT NULL,
        \`serialization\` VARCHAR(50) NOT NULL,
        \`semantic_uri\` VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        \`named_graph_uri\` VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        \`lifecycle_status\` ENUM('staged','validated','active','superseded','retired','failed') NOT NULL DEFAULT 'staged',
        \`validation_status\` ENUM('not_validated','integrity_validated','graph_verified','failed') NOT NULL DEFAULT 'not_validated',
        \`validation_summary_json\` JSON NULL,
        \`source_package_name\` VARCHAR(300) NOT NULL,
        \`source_package_version\` VARCHAR(100) NOT NULL,
        \`source_release_status\` VARCHAR(100) NOT NULL,
        \`privacy_classification\` ENUM('public_research_artifact','synthetic_runtime_data','synthetic_test_only','private_local','requires_manual_review') NOT NULL,
        \`predecessor_artifact_id\` BIGINT NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`validated_at\` DATETIME NULL,
        \`activated_at\` DATETIME NULL,
        \`superseded_at\` DATETIME NULL,
        \`retired_at\` DATETIME NULL,
        \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_semantic_artifact_uuid\` (\`artifact_uuid\`),
        UNIQUE KEY \`uq_semantic_artifact_family_version\` (\`family_id\`, \`semantic_version\`),
        UNIQUE KEY \`uq_semantic_artifact_graph_uri\` (\`named_graph_uri\`),
        UNIQUE KEY \`uq_semantic_artifact_family_hash\` (\`family_id\`, \`sha256\`),
        CONSTRAINT \`fk_semantic_artifact_family\` FOREIGN KEY (\`family_id\`) REFERENCES \`semantic_artifact_families\` (\`id\`),
        CONSTRAINT \`fk_semantic_artifact_predecessor\` FOREIGN KEY (\`predecessor_artifact_id\`) REFERENCES \`semantic_artifacts\` (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

    await conn.query(`ALTER TABLE \`semantic_artifact_families\`
        ADD CONSTRAINT \`fk_semantic_family_current_artifact\`
        FOREIGN KEY (\`current_artifact_id\`) REFERENCES \`semantic_artifacts\` (\`id\`)`);

    await conn.query(`CREATE TABLE \`semantic_artifact_load_operations\` (
        \`id\` BIGINT NOT NULL AUTO_INCREMENT,
        \`operation_uuid\` CHAR(36) NOT NULL,
        \`idempotency_key\` VARCHAR(300) NOT NULL,
        \`artifact_id\` BIGINT NOT NULL,
        \`operation_type\` ENUM('load_and_activate','load_without_activation','activate_existing','rollback_activation') NOT NULL,
        \`status\` ENUM('pending_validation','validated','pending_graph','graph_written','pending_activation','completed','failed_retryable','failed_terminal') NOT NULL DEFAULT 'pending_validation',
        \`payload_hash\` CHAR(64) NOT NULL,
        \`attempt_count\` INT NOT NULL DEFAULT 0,
        \`previous_artifact_id\` BIGINT NULL,
        \`error_code\` VARCHAR(100) NULL,
        \`error_message\` VARCHAR(1000) NULL,
        \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`started_at\` DATETIME NULL,
        \`graph_written_at\` DATETIME NULL,
        \`activated_at\` DATETIME NULL,
        \`completed_at\` DATETIME NULL,
        \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_semantic_load_operation_uuid\` (\`operation_uuid\`),
        UNIQUE KEY \`uq_semantic_load_idempotency_key\` (\`idempotency_key\`),
        KEY \`idx_semantic_load_artifact_status\` (\`artifact_id\`, \`status\`),
        CONSTRAINT \`fk_semantic_load_artifact\` FOREIGN KEY (\`artifact_id\`) REFERENCES \`semantic_artifacts\` (\`id\`),
        CONSTRAINT \`fk_semantic_load_previous_artifact\` FOREIGN KEY (\`previous_artifact_id\`) REFERENCES \`semantic_artifacts\` (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
}

/** Verbatim ALTERs from database/migrations/2026-07-20_ids_validation.sql. */
async function applyIdsValidationAlters(conn: mysql.Connection): Promise<void> {
    await conn.query(`ALTER TABLE \`semantic_artifacts\`
        ADD COLUMN \`storage_mode\` ENUM('graph_backed','file_executed') NOT NULL DEFAULT 'graph_backed' AFTER \`semantic_uri\`,
        MODIFY COLUMN \`named_graph_uri\` VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NULL,
        ADD COLUMN \`executor_metadata_json\` JSON NULL AFTER \`named_graph_uri\`,
        MODIFY COLUMN \`validation_status\` ENUM('not_validated','integrity_validated','graph_verified','file_verified','failed') NOT NULL DEFAULT 'not_validated'`);
    await conn.query(`ALTER TABLE \`semantic_artifact_load_operations\`
        MODIFY COLUMN \`status\` ENUM('pending_validation','validated','pending_graph','graph_written','file_validated','pending_activation','completed','failed_retryable','failed_terminal') NOT NULL DEFAULT 'pending_validation'`);
}

/** Verbatim ALTER from database/migrations/2026-07-21_semantic_reservation_evidence.sql. */
async function applyReservationEvidenceAlters(conn: mysql.Connection): Promise<void> {
    await conn.query(`ALTER TABLE \`semantic_artifact_families\`
        MODIFY COLUMN \`artifact_type\` ENUM(
            'ontology','bridge_vocabulary','shacl_shapes','institutional_dataset',
            'test_fixture','ids_profile','ifc_rdf_mapping','validation_report','semantic_policy'
        ) NOT NULL`);
}

/** Seeds the 3 governed families with an ACTIVE 1.0.0 source + a verified 1.1.0 target, via the REAL SemanticArtifactDatabase. */
async function seedBaseline(db: any): Promise<Record<string, { familyId: number; sourceId: number; targetId: number }>> {
    const info: Record<string, { familyId: number; sourceId: number; targetId: number }> = {};
    let seq = 0;
    const uuid = () => `20000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

    for (const familyKey of FAMILY_KEYS) {
        const storageMode = familyKey === SHAPES_FAMILY ? "graph_backed" : "file_executed";
        const artifactType = familyKey === SHAPES_FAMILY ? "shacl_shapes"
            : familyKey === MAPPING_FAMILY ? "ifc_rdf_mapping" : "ids_profile";
        const family = await db.ensureFamily({
            familyUuid: uuid(), artifactType, familyKey, name: familyKey,
            semanticUri: `https://selftest.example/${familyKey}`, privacyPolicy: "public_research_artifact",
        });

        async function makeRevision(version: string, activate: boolean) {
            const artifact = await db.ensureArtifact({
                artifactUuid: uuid(), familyId: Number(family.id), semanticVersion: version,
                sourceFilename: `${familyKey}-${version}.dat`, repositoryRelativePath: `runtime/${familyKey}/${version}/file`,
                byteSize: 100, sha256: crypto.createHash("sha256").update(`${familyKey}:${version}`).digest("hex"),
                mediaType: "application/json", serialization: "json",
                semanticUri: `https://selftest.example/${familyKey}/${version}`, storageMode,
                namedGraphUri: storageMode === "graph_backed" ? `https://selftest.example/graphs/${familyKey}/${version}` : null,
                executorMetadata: null,
                sourcePackageName: "oswadt-change-c-selftest", sourcePackageVersion: version, sourceReleaseStatus: "stable",
                privacyClassification: "public_research_artifact", predecessorArtifactId: null,
            });
            const operation = await db.ensureOperation({
                operationUuid: uuid(), idempotencyKey: `ctx-selftest-setup:${familyKey}:${version}`, artifactId: Number(artifact.id),
                operationType: activate ? "load_and_activate" : "load_without_activation", payloadHash: `hash:${familyKey}:${version}`,
                previousArtifactId: family.current_artifact_id === null ? null : Number(family.current_artifact_id),
            });
            if (storageMode === "graph_backed") {
                await db.markGraphVerified(operation.operation_uuid, Number(artifact.id), {
                    integrity: { kind: "integrity_validation", sha256: artifact.sha256, byteSize: 100, expectedTripleCount: 1, mediaType: "text/turtle", serialization: "turtle", validatedAt: "2026-01-01T00:00:00.000Z" },
                    fusekiLoading: { kind: "fuseki_parsing_loading_validation", accepted: true, graphUri: artifact.named_graph_uri },
                    postLoad: { kind: "post_load_graph_verification", tripleCount: 1, expectedResourcePresent: null },
                });
            } else {
                await db.markFileVerified(operation.operation_uuid, Number(artifact.id), { kind: "declarative_schema", accepted: true });
            }
            if (activate) {
                await db.activateArtifact({
                    operationUuid: operation.operation_uuid, familyId: Number(family.id), artifactId: Number(artifact.id),
                    expectedCurrentArtifactId: family.current_artifact_id === null ? null : Number(family.current_artifact_id),
                });
            }
            return Number(artifact.id);
        }

        const sourceId = await makeRevision(SOURCE_VERSION, true);
        const targetId = await makeRevision(TARGET_VERSION, false);
        info[familyKey] = { familyId: Number(family.id), sourceId, targetId };
    }
    return info;
}

/** Classifies an observed snapshot as "source", "target", "mixed", or an error label. */
function classify(rows: any[]): string {
    if (rows.length !== 3) return `incomplete(${rows.length})`;
    const versions = FAMILY_KEYS.map((key) => rows.find((row) => row.family_key === key)?.semantic_version ?? "none");
    if (versions.every((v) => v === SOURCE_VERSION)) return "source";
    if (versions.every((v) => v === TARGET_VERSION)) return "target";
    return `mixed(${versions.join("/")})`;
}

/** Direct-SQL reset back to the seeded baseline. Does not use the code under test. */
async function resetToBaseline(conn: mysql.Connection, info: Record<string, { familyId: number; sourceId: number; targetId: number }>): Promise<void> {
    for (const familyKey of FAMILY_KEYS) {
        const { familyId, sourceId, targetId } = info[familyKey]!;
        await conn.query(`UPDATE semantic_artifact_families SET current_artifact_id = ? WHERE id = ?`, [sourceId, familyId]);
        await conn.query(`UPDATE semantic_artifacts SET lifecycle_status = 'active', superseded_at = NULL WHERE id = ?`, [sourceId]);
        await conn.query(`UPDATE semantic_artifacts SET lifecycle_status = 'validated', activated_at = NULL WHERE id = ?`, [targetId]);
    }
}

/** Direct-SQL atomic three-pointer flip in ONE transaction (the shape Change B commits). */
async function atomicFlip(conn: mysql.Connection, info: Record<string, { familyId: number; sourceId: number; targetId: number }>,
    toTarget: boolean, jitterMs: () => number): Promise<void> {
    await conn.query("BEGIN");
    for (const familyKey of FAMILY_KEYS) {
        const { familyId, sourceId, targetId } = info[familyKey]!;
        const next = toTarget ? targetId : sourceId;
        const previous = toTarget ? sourceId : targetId;
        await conn.query(`UPDATE semantic_artifacts SET lifecycle_status = 'superseded' WHERE id = ?`, [previous]);
        await conn.query(`UPDATE semantic_artifacts SET lifecycle_status = 'active' WHERE id = ?`, [next]);
        await conn.query(`UPDATE semantic_artifact_families SET current_artifact_id = ? WHERE id = ?`, [next, familyId]);
        // Orchestration-only jitter — no sleep of any kind lives inside the production SQL.
        await sleep(jitterMs());
    }
    await conn.query("COMMIT");
}

async function main(): Promise<void> {
    const operationalDb = process.env.DB_NAME;
    const schema = `oswadt_semantic_context_selftest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    if (schema === operationalDb || schema === "digital_twin") throw new Error("refusing to reuse the operational database name");
    const baseConfig = {
        host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
        user: process.env.DB_USER, password: process.env.DB_PASSWORD, multipleStatements: false,
    } as any;

    const server = await mysql.createConnection(baseConfig);
    const [[versionRow]]: any = await server.query("SELECT VERSION() AS v, @@GLOBAL.transaction_isolation AS iso");
    console.log(JSON.stringify({
        event: "semantic_context_selftest_start",
        disposableSchema: schema, operationalDatabase: operationalDb,
        mysqlVersion: versionRow.v, isolationLevel: versionRow.iso,
        note: "operational database is never selected or modified",
    }));

    await server.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const conn = await mysql.createConnection({ ...baseConfig, database: schema } as any);

    // Point the PRODUCTION classes at the disposable schema before importing them.
    process.env.DB_NAME = schema;
    const { SemanticArtifactDatabase } = await import("../utils/semanticArtifactDatabase.ts");
    const { buildSemanticExecutionContext } = await import("../modelIntake/semanticExecutionContext.ts");

    let mixedObservations = 0;
    let raceSnapshots = 0;

    try {
        await buildBaseSchema(conn);
        await applyIdsValidationAlters(conn);
        await applyReservationEvidenceAlters(conn);
        console.log(`  storage engine: ${await scalar(conn, `SELECT ENGINE FROM information_schema.tables WHERE table_schema=? AND table_name='semantic_artifacts'`, [schema])}`);
        console.log(`  session isolation: ${await scalar(conn, `SELECT @@SESSION.transaction_isolation`)}`);

        const setupDb = new SemanticArtifactDatabase();
        const info = await seedBaseline(setupDb);

        // ---- TEST 1: full source current -> snapshot returns full source ----
        console.log("  [1] real MySQL: full 1.0.0 source current -> snapshot returns full source");
        {
            const db = new SemanticArtifactDatabase();
            const rows = await db.resolveCurrentArtifactSet([...FAMILY_KEYS]);
            check("1.1 exactly three rows", rows.length === 3, `got ${rows.length}`);
            check("1.2 classified as full source", classify(rows) === "source", classify(rows));
            const context = await buildSemanticExecutionContext(db);
            check("1.3 real context builder accepts the source set", context.ids.semanticVersion === SOURCE_VERSION
                && context.mapping.semanticVersion === SOURCE_VERSION && context.shapes.semanticVersion === SOURCE_VERSION);
            check("1.4 pinned ids match the seeded source artifacts",
                context.ids.artifactId === info[IDS_FAMILY]!.sourceId
                && context.mapping.artifactId === info[MAPPING_FAMILY]!.sourceId
                && context.shapes.artifactId === info[SHAPES_FAMILY]!.sourceId);
            check("1.5 shapes selection carries a named graph URI", typeof context.shapes.namedGraphUri === "string" && context.shapes.namedGraphUri.length > 0);
        }

        // ---- TEST 2: full target current -> snapshot returns full target ----
        console.log("  [2] real MySQL: full 1.1.0 target current -> snapshot returns full target");
        {
            const flipper = await mysql.createConnection({ ...baseConfig, database: schema } as any);
            await atomicFlip(flipper, info, true, () => 0);
            await flipper.end();
            const db = new SemanticArtifactDatabase();
            const rows = await db.resolveCurrentArtifactSet([...FAMILY_KEYS]);
            check("2.1 classified as full target", classify(rows) === "target", classify(rows));
            const context = await buildSemanticExecutionContext(db);
            check("2.2 real context builder accepts the target set", context.ids.semanticVersion === TARGET_VERSION
                && context.mapping.semanticVersion === TARGET_VERSION && context.shapes.semanticVersion === TARGET_VERSION);
            check("2.3 pinned ids match the seeded target artifacts",
                context.ids.artifactId === info[IDS_FAMILY]!.targetId
                && context.mapping.artifactId === info[MAPPING_FAMILY]!.targetId
                && context.shapes.artifactId === info[SHAPES_FAMILY]!.targetId);
        }
        await resetToBaseline(conn, info);

        // ---- TEST 3: an UNCOMMITTED three-pointer transaction is never observed ----
        console.log("  [3] real MySQL: an uncommitted flip on connection B is invisible to A's snapshot");
        {
            const db = new SemanticArtifactDatabase();
            const before = await db.resolveCurrentArtifactSet([...FAMILY_KEYS]);
            check("3.1 baseline is full source", classify(before) === "source", classify(before));

            const connB = await mysql.createConnection({ ...baseConfig, database: schema } as any);
            await connB.query("BEGIN");
            for (const familyKey of FAMILY_KEYS) {
                const { familyId, targetId } = info[familyKey]!;
                await connB.query(`UPDATE semantic_artifact_families SET current_artifact_id = ? WHERE id = ?`, [targetId, familyId]);
                await connB.query(`UPDATE semantic_artifacts SET lifecycle_status = 'active' WHERE id = ?`, [targetId]);
                await connB.query(`UPDATE semantic_artifacts SET lifecycle_status = 'superseded' WHERE id = ?`, [info[familyKey]!.sourceId]);
            }
            // NOT committed yet.
            const during = await db.resolveCurrentArtifactSet([...FAMILY_KEYS]);
            const duringClass = classify(during);
            if (duringClass.startsWith("mixed")) mixedObservations += 1;
            check("3.2 uncommitted flip is invisible: snapshot is still full source", duringClass === "source", duringClass);
            check("3.3 snapshot during the open transaction is never mixed", !duringClass.startsWith("mixed"), duringClass);

            await connB.query("COMMIT");
            await connB.end();
            const after = await db.resolveCurrentArtifactSet([...FAMILY_KEYS]);
            check("3.4 a fresh snapshot after COMMIT is full target", classify(after) === "target", classify(after));
        }

        // ---- TEST 4: bounded race — every observed snapshot is full-source or full-target ----
        console.log("  [4] real MySQL: 24 jittered atomic-flip races -> never a mixed snapshot");
        {
            const db = new SemanticArtifactDatabase();
            const flipper = await mysql.createConnection({ ...baseConfig, database: schema } as any);
            const observed = new Map<string, number>();
            let stop = false;
            const reader = (async () => {
                while (!stop) {
                    const rows = await db.resolveCurrentArtifactSet([...FAMILY_KEYS]);
                    const label = classify(rows);
                    raceSnapshots += 1;
                    observed.set(label, (observed.get(label) ?? 0) + 1);
                    if (label.startsWith("mixed")) mixedObservations += 1;
                }
            })();

            for (let round = 0; round < 24; round++) {
                await atomicFlip(flipper, info, round % 2 === 0, () => Math.floor(Math.random() * 4));
                await sleep(Math.floor(Math.random() * 3));
            }
            stop = true;
            await reader;
            await flipper.end();

            console.log(`    observed snapshot classes: ${JSON.stringify([...observed.entries()])} over ${raceSnapshots} reads`);
            check("4.1 at least one full-source and one full-target snapshot were actually observed",
                (observed.get("source") ?? 0) > 0 && (observed.get("target") ?? 0) > 0);
            check("4.2 ZERO mixed snapshots across all races", mixedObservations === 0, `${mixedObservations} mixed observations`);
            check("4.3 every observed class is source or target", [...observed.keys()].every((k) => k === "source" || k === "target"),
                JSON.stringify([...observed.keys()]));
        }

        // ---- TEST 5: a stable COMMITTED, INDEPENDENTLY VERSIONED current set is accepted ----
        //
        // Frozen governance model: the three governed families are independently versioned.
        // A committed set where only the IDS family has advanced is a legitimate governed
        // combination chosen by the BIM manager, NOT an incompatibility for runtime to
        // detect. The real builder must capture it coherently and succeed.
        console.log("  [5] real MySQL: a committed independently-versioned current set is captured and accepted");
        {
            await resetToBaseline(conn, info);
            // Move ONLY the IDS family: ids=target, mapping=source, shapes=source.
            const ids = info[IDS_FAMILY]!;
            await conn.query(`UPDATE semantic_artifact_families SET current_artifact_id = ? WHERE id = ?`, [ids.targetId, ids.familyId]);
            await conn.query(`UPDATE semantic_artifacts SET lifecycle_status = 'active' WHERE id = ?`, [ids.targetId]);
            await conn.query(`UPDATE semantic_artifacts SET lifecycle_status = 'superseded' WHERE id = ?`, [ids.sourceId]);

            const db = new SemanticArtifactDatabase();
            const rows = await db.resolveCurrentArtifactSet([...FAMILY_KEYS]);
            const label = classify(rows);
            check("5.1 the snapshot faithfully reports the committed independently-versioned state",
                label.startsWith("mixed"), label);

            let context: any = null; let code = "";
            try { context = await buildSemanticExecutionContext(db); } catch (e: any) { code = e?.code ?? String(e); }
            check("5.2 the real context builder ACCEPTS the independently-versioned set",
                context !== null, code || "(unexpected rejection)");
            check("5.3 the captured context is exactly the committed set",
                context !== null
                && Number(context.ids.artifactId) === Number(ids.targetId)
                && Number(context.mapping.artifactId) === Number(info[MAPPING_FAMILY]!.sourceId)
                && Number(context.shapes.artifactId) === Number(info[SHAPES_FAMILY]!.sourceId),
                context ? `ids=${context.ids.artifactId} mapping=${context.mapping.artifactId} shapes=${context.shapes.artifactId}` : "(no context)");

            // ---- 5b: a GENUINELY incoherent committed row still fails closed on the real
            // engine. This is per-artifact eligibility (the pointed-at revision is not
            // active), never a cross-family version rule.
            await conn.query(`UPDATE semantic_artifacts SET lifecycle_status = 'retired' WHERE id = ?`, [ids.targetId]);
            let retiredCode = "";
            try { await buildSemanticExecutionContext(db); } catch (e: any) { retiredCode = e?.code ?? ""; }
            check("5.4 a current pointer at a non-active revision still fails closed",
                retiredCode === "semantic_context_artifact_not_active", retiredCode || "(no error thrown)");
            await conn.query(`UPDATE semantic_artifacts SET lifecycle_status = 'active' WHERE id = ?`, [ids.targetId]);
        }

        // ---- TEST 6: caller-contract violations and NULL pointer observability ----
        console.log("  [6] real MySQL: caller-contract validation and LEFT JOIN NULL observability");
        {
            const db = new SemanticArtifactDatabase();
            let emptyThrew = false, dupThrew = false;
            try { await db.resolveCurrentArtifactSet([]); } catch { emptyThrew = true; }
            try { await db.resolveCurrentArtifactSet([IDS_FAMILY, IDS_FAMILY]); } catch { dupThrew = true; }
            check("6.1 empty family-key list is rejected", emptyThrew);
            check("6.2 duplicate family keys are rejected", dupThrew);

            const missing = await db.resolveCurrentArtifactSet(["oswadt-no-such-family"]);
            check("6.3 a missing family simply does not appear", missing.length === 0, `got ${missing.length}`);

            const shapes = info[SHAPES_FAMILY]!;
            await conn.query(`UPDATE semantic_artifact_families SET current_artifact_id = NULL WHERE id = ?`, [shapes.familyId]);
            const withNull = await db.resolveCurrentArtifactSet([SHAPES_FAMILY]);
            check("6.4 a NULL current pointer is still returned as a row (LEFT JOIN, not INNER)", withNull.length === 1, `got ${withNull.length}`);
            check("6.5 the NULL pointer and its null artifact columns are observable",
                withNull[0]?.current_artifact_id === null && withNull[0]?.artifact_id === null);
            let nullCode = "";
            try { await buildSemanticExecutionContext(db); } catch (e: any) { nullCode = e?.code ?? ""; }
            check("6.6 the real builder fails closed on a NULL current pointer",
                nullCode === "semantic_context_current_pointer_missing", nullCode || "(no error thrown)");
            await conn.query(`UPDATE semantic_artifact_families SET current_artifact_id = ? WHERE id = ?`, [shapes.sourceId, shapes.familyId]);
        }
    } finally {
        await conn.end();
        await server.query(`DROP DATABASE \`${schema}\``);
        const [stillExists]: any = await server.query(`SELECT SCHEMA_NAME FROM information_schema.schemata WHERE SCHEMA_NAME=?`, [schema]);
        const [operationalStillExists]: any = await server.query(`SELECT SCHEMA_NAME FROM information_schema.schemata WHERE SCHEMA_NAME=?`, [operationalDb]);
        console.log(JSON.stringify({
            event: "semantic_context_selftest_end",
            disposableSchemaDropped: schema, disposableSchemaStillExists: stillExists.length > 0,
            operationalDatabaseStillExists: operationalStillExists.length > 0,
            raceSnapshotsObserved: raceSnapshots, mixedSnapshotsEverObserved: mixedObservations,
            passes, failures,
        }));
        await server.end();
    }
    // Each SemanticArtifactDatabase opened its own mysql2 pool against the (now dropped)
    // disposable schema; exit explicitly so those pools cannot keep the process alive.
    process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
