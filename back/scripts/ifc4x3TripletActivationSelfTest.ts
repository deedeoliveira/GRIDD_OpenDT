/**
 * Disposable-schema self-test for Change B (atomic IFC4x3 triplet activation):
 *   back/utils/semanticArtifactDatabase.ts — activateArtifactSet / applyActivationMutation
 *   back/semantic/ifc4x3TripletActivationService.ts — Ifc4x3TripletActivationService
 *
 * Creates a brand-new throwaway schema on the configured MySQL SERVER (NEVER the
 * operational database named by DB_NAME/`digital_twin`), builds a faithful subset of
 * the real semantic-artifact registry schema (base CREATE TABLE statements from
 * database/migrations/2026-07-20_semantic_artifact_registry.sql, PLUS the two later
 * ALTER TABLE statements from 2026-07-20_ids_validation.sql — storage_mode,
 * executor_metadata_json, the widened validation_status/status ENUMs — and from
 * 2026-07-21_semantic_reservation_evidence.sql — the widened artifact_type ENUM —
 * copied verbatim; every OTHER CREATE TABLE statement in those three files is
 * intentionally omitted because Change B does not touch those unrelated tables),
 * then exercises the REAL `SemanticArtifactDatabase` and `Ifc4x3TripletActivationService`
 * production classes against genuine `mysql2/promise` connections and real InnoDB
 * transactions/locks/rollback. The disposable schema is ALWAYS dropped afterwards;
 * `digital_twin` is never selected, queried, or modified.
 *
 * Usage (safe): npx tsx scripts/ifc4x3TripletActivationSelfTest.ts
 */
import "dotenv/config";
import crypto from "node:crypto";
import mysql from "mysql2/promise";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
    if (condition) console.log(`    PASS  ${name}`);
    else { failures += 1; console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
async function scalar(conn: mysql.Connection, sql: string, params: any[] = []): Promise<any> {
    const [rows]: any = await conn.query(sql, params);
    const row = rows[0] ?? {};
    return row[Object.keys(row)[0] as string];
}
async function firstRow(conn: mysql.Connection, sql: string, params: any[] = []): Promise<any> {
    const [rows]: any = await conn.query(sql, params);
    return rows[0] ?? {};
}
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const FAMILY_KEYS = [
    "oswadt-ifc4-model-requirements",
    "oswadt-ifc4-minimal-rdf-mapping",
    "oswadt-model-rdf-structural-shapes",
] as const;
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

/** Verbatim ALTERs from database/migrations/2026-07-20_ids_validation.sql (storage_mode / executor_metadata_json / widened ENUMs). */
async function applyIdsValidationAlters(conn: mysql.Connection): Promise<void> {
    await conn.query(`ALTER TABLE \`semantic_artifacts\`
        ADD COLUMN \`storage_mode\` ENUM('graph_backed','file_executed') NOT NULL DEFAULT 'graph_backed' AFTER \`semantic_uri\`,
        MODIFY COLUMN \`named_graph_uri\` VARCHAR(1000) CHARACTER SET ascii COLLATE ascii_bin NULL,
        ADD COLUMN \`executor_metadata_json\` JSON NULL AFTER \`named_graph_uri\`,
        MODIFY COLUMN \`validation_status\` ENUM('not_validated','integrity_validated','graph_verified','file_verified','failed') NOT NULL DEFAULT 'not_validated'`);
    await conn.query(`ALTER TABLE \`semantic_artifact_load_operations\`
        MODIFY COLUMN \`status\` ENUM('pending_validation','validated','pending_graph','graph_written','file_validated','pending_activation','completed','failed_retryable','failed_terminal') NOT NULL DEFAULT 'pending_validation'`);
}

/** Verbatim ALTER from database/migrations/2026-07-21_semantic_reservation_evidence.sql (widened artifact_type ENUM). */
async function applyReservationEvidenceAlters(conn: mysql.Connection): Promise<void> {
    await conn.query(`ALTER TABLE \`semantic_artifact_families\`
        MODIFY COLUMN \`artifact_type\` ENUM(
            'ontology','bridge_vocabulary','shacl_shapes','institutional_dataset',
            'test_fixture','ids_profile','ifc_rdf_mapping','validation_report','semantic_policy'
        ) NOT NULL`);
}

/** Seeds the 3 governed families with an ACTIVE 1.0.0 source + a validated 1.1.0 target, using the REAL SemanticArtifactDatabase methods (not raw SQL). */
async function seedBaseline(db: any): Promise<Record<string, { familyId: number; sourceId: number; targetId: number }>> {
    const info: Record<string, { familyId: number; sourceId: number; targetId: number }> = {};
    let seq = 0;
    const uuid = () => `10000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

    for (const familyKey of FAMILY_KEYS) {
        const storageMode = familyKey === "oswadt-model-rdf-structural-shapes" ? "graph_backed" : "file_executed";
        const artifactType = familyKey === "oswadt-model-rdf-structural-shapes" ? "shacl_shapes"
            : familyKey === "oswadt-ifc4-minimal-rdf-mapping" ? "ifc_rdf_mapping" : "ids_profile";

        const family = await db.ensureFamily({
            familyUuid: uuid(), artifactType, familyKey, name: familyKey,
            semanticUri: `https://selftest.example/${familyKey}`, privacyPolicy: "public_research_artifact",
        });

        async function makeRevision(version: string, activate: boolean) {
            const artifact = await db.ensureArtifact({
                artifactUuid: uuid(), familyId: Number(family.id), semanticVersion: version,
                sourceFilename: `${familyKey}-${version}.dat`, repositoryRelativePath: `runtime/${familyKey}/${version}/file`,
                byteSize: 100, sha256: crypto.createHash("sha256").update(`${familyKey}:${version}:${uuid()}`).digest("hex"), mediaType: "application/json", serialization: "json",
                semanticUri: `https://selftest.example/${familyKey}/${version}`, storageMode,
                namedGraphUri: storageMode === "graph_backed" ? `https://selftest.example/graphs/${familyKey}/${version}` : null,
                executorMetadata: null,
                sourcePackageName: "oswadt-ifc4x3-compat-selftest", sourcePackageVersion: version, sourceReleaseStatus: "stable",
                privacyClassification: "public_research_artifact", predecessorArtifactId: null,
            });
            const operation = await db.ensureOperation({
                operationUuid: uuid(), idempotencyKey: `selftest-setup:${familyKey}:${version}`, artifactId: Number(artifact.id),
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
                await db.markFileVerified(operation.operation_uuid, Number(artifact.id), { kind: "declarative_mapping_schema", accepted: true });
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

/** Direct-SQL reset back to the seeded baseline (source active/current, target validated/inactive, operation rows pending with no previous_artifact_id). Used between real-DB test cases; does not use the code under test. */
async function resetToBaseline(conn: mysql.Connection, info: Record<string, { familyId: number; sourceId: number; targetId: number }>): Promise<void> {
    for (const familyKey of FAMILY_KEYS) {
        const { familyId, sourceId, targetId } = info[familyKey]!;
        await conn.query(`UPDATE semantic_artifact_families SET current_artifact_id = ? WHERE id = ?`, [sourceId, familyId]);
        await conn.query(`UPDATE semantic_artifacts SET lifecycle_status = 'active', superseded_at = NULL WHERE id = ?`, [sourceId]);
        await conn.query(`UPDATE semantic_artifacts SET lifecycle_status = 'validated', activated_at = NULL WHERE id = ?`, [targetId]);
        await conn.query(`UPDATE semantic_artifact_load_operations SET status = 'pending_validation', activated_at = NULL, completed_at = NULL, previous_artifact_id = NULL WHERE idempotency_key = ?`, [`ifc4x3-triplet-activation:${TARGET_VERSION}:${familyKey}`]);
    }
}

async function main(): Promise<void> {
    const operationalDb = process.env.DB_NAME;
    const schema = `oswadt_ifc4x3_triplet_selftest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    if (schema === operationalDb || schema === "digital_twin") throw new Error("refusing to reuse the operational database name");
    const baseConfig = {
        host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
        user: process.env.DB_USER, password: process.env.DB_PASSWORD, multipleStatements: false,
    } as any;

    const server = await mysql.createConnection(baseConfig);
    const [[versionRow]]: any = await server.query("SELECT VERSION() AS v, @@GLOBAL.transaction_isolation AS iso");
    console.log(JSON.stringify({
        event: "ifc4x3_triplet_selftest_start",
        disposableSchema: schema, operationalDatabase: operationalDb,
        mysqlVersion: versionRow.v, isolationLevel: versionRow.iso,
        note: "operational database is never selected or modified",
    }));
    if (schema === operationalDb) throw new Error("unreachable: generated schema equals operational DB");

    await server.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
    const conn = await mysql.createConnection({ ...baseConfig, database: schema } as any);

    // Point the PRODUCTION database classes at the disposable schema. Real MySQLDatabase
    // instances read process.env at construction time, so every SemanticArtifactDatabase
    // built AFTER this line targets the throwaway schema, never `digital_twin`.
    process.env.DB_NAME = schema;
    const { SemanticArtifactDatabase } = await import("../utils/semanticArtifactDatabase.ts");
    const { Ifc4x3TripletActivationService } = await import("../semantic/ifc4x3TripletActivationService.ts");

    try {
        await buildBaseSchema(conn);
        await applyIdsValidationAlters(conn);
        await applyReservationEvidenceAlters(conn);
        console.log(`  storage engine: ${await scalar(conn, `SELECT ENGINE FROM information_schema.tables WHERE table_schema=? AND table_name='semantic_artifacts'`, [schema])}`);

        const setupDb = new SemanticArtifactDatabase();
        const info = await seedBaseline(setupDb);

        // ---- TEST 1: full source → target commits all three, with truthful provenance ----
        console.log("  [1] real InnoDB: full 1.0.0 source -> full 1.1.0 target");
        {
            const service = new Ifc4x3TripletActivationService(new SemanticArtifactDatabase());
            const result = await service.activateGovernedTargetSet();
            check("1.1 status=activated", result.status === "activated");
            for (const familyKey of FAMILY_KEYS) {
                const { familyId, sourceId, targetId } = info[familyKey]!;
                check(`1.2 ${familyKey} current pointer = target`, Number(await scalar(conn, `SELECT current_artifact_id FROM semantic_artifact_families WHERE id=?`, [familyId])) === targetId);
                check(`1.3 ${familyKey} source superseded`, await scalar(conn, `SELECT lifecycle_status FROM semantic_artifacts WHERE id=?`, [sourceId]) === "superseded");
                check(`1.4 ${familyKey} target active`, await scalar(conn, `SELECT lifecycle_status FROM semantic_artifacts WHERE id=?`, [targetId]) === "active");
                const op = await firstRow(conn, `SELECT status, previous_artifact_id FROM semantic_artifact_load_operations WHERE idempotency_key=?`, [`ifc4x3-triplet-activation:${TARGET_VERSION}:${familyKey}`]);
                check(`1.5 ${familyKey} operation completed`, op.status === "completed");
                check(`1.6 ${familyKey} previous_artifact_id = TRUE 1.0.0 source`, Number(op.previous_artifact_id) === sourceId, `got ${op.previous_artifact_id}, expected ${sourceId}`);
            }
        }
        await resetToBaseline(conn, info);

        // ---- TEST 2: a REAL server-side error after the first family's writes causes a REAL InnoDB rollback ----
        console.log("  [2] real InnoDB: server-side failure after partial writes -> real ROLLBACK, zero mutation");
        {
            // Deterministic lock order is alphabetical family_key; the 2nd family is
            // "oswadt-ifc4-model-requirements". Fire when ITS target row is set to 'active'.
            const secondFamilyTargetId = info["oswadt-ifc4-model-requirements"]!.targetId;
            await conn.query(`
                CREATE TRIGGER trg_selftest_fail_second_family BEFORE UPDATE ON semantic_artifacts
                FOR EACH ROW
                BEGIN
                    IF NEW.id = ${Number(secondFamilyTargetId)} AND NEW.lifecycle_status = 'active' THEN
                        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'self-test injected mid-transaction failure';
                    END IF;
                END
            `);
            try {
                const service = new Ifc4x3TripletActivationService(new SemanticArtifactDatabase());
                let threw = false;
                try { await service.activateGovernedTargetSet(); } catch { threw = true; }
                check("2.1 activation threw on the injected server-side error", threw);
                for (const familyKey of FAMILY_KEYS) {
                    const { familyId, sourceId, targetId } = info[familyKey]!;
                    check(`2.2 ${familyKey} still source-current after rollback`, Number(await scalar(conn, `SELECT current_artifact_id FROM semantic_artifact_families WHERE id=?`, [familyId])) === sourceId);
                    check(`2.3 ${familyKey} source still active (real undo log, not a JS reconstruction)`, await scalar(conn, `SELECT lifecycle_status FROM semantic_artifacts WHERE id=?`, [sourceId]) === "active");
                    check(`2.4 ${familyKey} target still validated/inactive`, await scalar(conn, `SELECT lifecycle_status FROM semantic_artifacts WHERE id=?`, [targetId]) === "validated");
                }
            } finally {
                await conn.query(`DROP TRIGGER IF EXISTS trg_selftest_fail_second_family`);
            }
        }

        // ---- TEST 3: mixed source fails closed with zero mutation ----
        console.log("  [3] real InnoDB: mixed source fails closed");
        {
            const ids = info["oswadt-ifc4-model-requirements"]!;
            await conn.query(`UPDATE semantic_artifact_families SET current_artifact_id=? WHERE id=?`, [ids.targetId, ids.familyId]);
            await conn.query(`UPDATE semantic_artifacts SET lifecycle_status='active' WHERE id=?`, [ids.targetId]);
            await conn.query(`UPDATE semantic_artifacts SET lifecycle_status='superseded' WHERE id=?`, [ids.sourceId]);

            const service = new Ifc4x3TripletActivationService(new SemanticArtifactDatabase());
            let code = "";
            try { await service.activateGovernedTargetSet(); } catch (e: any) { code = e?.code ?? ""; }
            check("3.1 activation_conflict", code === "activation_conflict");
            check("3.2 IDS family pointer unchanged (still mixed, no further mutation)", Number(await scalar(conn, `SELECT current_artifact_id FROM semantic_artifact_families WHERE id=?`, [ids.familyId])) === ids.targetId);
            for (const familyKey of ["oswadt-ifc4-minimal-rdf-mapping", "oswadt-model-rdf-structural-shapes"] as const) {
                const { familyId, sourceId } = info[familyKey]!;
                check(`3.3 ${familyKey} untouched source`, Number(await scalar(conn, `SELECT current_artifact_id FROM semantic_artifact_families WHERE id=?`, [familyId])) === sourceId);
            }
            // Revert the manual mixed-state seed back to baseline for subsequent tests.
            await conn.query(`UPDATE semantic_artifact_families SET current_artifact_id=? WHERE id=?`, [ids.sourceId, ids.familyId]);
            await conn.query(`UPDATE semantic_artifacts SET lifecycle_status='active' WHERE id=?`, [ids.sourceId]);
            await conn.query(`UPDATE semantic_artifacts SET lifecycle_status='validated' WHERE id=?`, [ids.targetId]);
        }

        // ---- TEST 4: real row-lock blocking across two genuine connections ----
        console.log("  [4] real InnoDB: a held FOR UPDATE row lock blocks activation until released");
        {
            const shapes = info["oswadt-model-rdf-structural-shapes"]!;
            const connA = await mysql.createConnection({ ...baseConfig, database: schema } as any);
            await connA.query("BEGIN");
            await connA.query(`SELECT * FROM semantic_artifact_families WHERE id=? FOR UPDATE`, [shapes.familyId]);

            const service = new Ifc4x3TripletActivationService(new SemanticArtifactDatabase());
            const activationPromise = service.activateGovernedTargetSet();
            const raced = await Promise.race([
                activationPromise.then(() => "resolved").catch(() => "resolved"),
                sleep(800).then(() => "timeout"),
            ]);
            check("4.1 activation does NOT complete while the row lock is held", raced === "timeout");

            await connA.query("COMMIT");
            await connA.end();
            const result = await activationPromise;
            check("4.2 activation completes correctly once the lock is released", result.status === "activated");
            for (const familyKey of FAMILY_KEYS) {
                const { familyId, targetId } = info[familyKey]!;
                check(`4.3 ${familyKey} ended on target after unblocking`, Number(await scalar(conn, `SELECT current_artifact_id FROM semantic_artifact_families WHERE id=?`, [familyId])) === targetId);
            }
        }
        await resetToBaseline(conn, info);

        // ---- TEST 5: two concurrent real activations never produce partial state ----
        console.log("  [5] real InnoDB: two concurrent activations -> no partial state, final coherence");
        {
            const serviceA = new Ifc4x3TripletActivationService(new SemanticArtifactDatabase());
            const serviceB = new Ifc4x3TripletActivationService(new SemanticArtifactDatabase());
            const [a, b] = await Promise.allSettled([serviceA.activateGovernedTargetSet(), serviceB.activateGovernedTargetSet()]);
            const outcomes = [a, b].map((r) => r.status === "fulfilled" ? r.value.status : `rejected:${(r as PromiseRejectedResult).reason?.code ?? (r as PromiseRejectedResult).reason?.message}`);
            console.log(`    observed outcomes: ${JSON.stringify(outcomes)}`);
            check("5.1 at least one caller activated or observed already_active (no silent double-failure)", outcomes.some((o) => o === "activated" || o === "already_active"));
            for (const familyKey of FAMILY_KEYS) {
                const { familyId, targetId } = info[familyKey]!;
                check(`5.2 ${familyKey} final state is fully on target (never a mix)`, Number(await scalar(conn, `SELECT current_artifact_id FROM semantic_artifact_families WHERE id=?`, [familyId])) === targetId);
            }
        }

        // ---- TEST 6: real-DB provenance retry regression (mixed fail -> recovery -> retry) ----
        console.log("  [6] real InnoDB: mixed-failure -> recovery -> retry keeps TRUTHFUL previous_artifact_id");
        {
            // Reset fully, including operation rows, then re-run a mixed failure -> recovery -> retry cycle.
            await resetToBaseline(conn, info);
            const ids = info["oswadt-ifc4-model-requirements"]!;
            await conn.query(`UPDATE semantic_artifact_families SET current_artifact_id=? WHERE id=?`, [ids.targetId, ids.familyId]);
            await conn.query(`UPDATE semantic_artifacts SET lifecycle_status='active' WHERE id=?`, [ids.targetId]);
            await conn.query(`UPDATE semantic_artifacts SET lifecycle_status='superseded' WHERE id=?`, [ids.sourceId]);

            const attempt1 = new Ifc4x3TripletActivationService(new SemanticArtifactDatabase());
            let threw = false;
            try { await attempt1.activateGovernedTargetSet(); } catch { threw = true; }
            check("6.1 attempt 1 (mixed) fails closed", threw);
            const survivingOps = await firstRow(conn, `SELECT COUNT(*) AS c FROM semantic_artifact_load_operations WHERE idempotency_key LIKE 'ifc4x3-triplet-activation:%'`);
            check("6.2 operation rows survive the failed attempt", Number(survivingOps.c) === 3);

            // External recovery: IDS reverted to its true 1.0.0 source. Operation rows untouched.
            await conn.query(`UPDATE semantic_artifact_families SET current_artifact_id=? WHERE id=?`, [ids.sourceId, ids.familyId]);
            await conn.query(`UPDATE semantic_artifacts SET lifecycle_status='active' WHERE id=?`, [ids.sourceId]);
            await conn.query(`UPDATE semantic_artifacts SET lifecycle_status='validated' WHERE id=?`, [ids.targetId]);

            const attempt2 = new Ifc4x3TripletActivationService(new SemanticArtifactDatabase());
            const result = await attempt2.activateGovernedTargetSet();
            check("6.3 attempt 2 (recovered, genuinely valid) succeeds", result.status === "activated");

            for (const familyKey of FAMILY_KEYS) {
                const { sourceId, targetId } = info[familyKey]!;
                const op = await firstRow(conn, `SELECT previous_artifact_id FROM semantic_artifact_load_operations WHERE idempotency_key=?`, [`ifc4x3-triplet-activation:${TARGET_VERSION}:${familyKey}`]);
                check(`6.4 ${familyKey} final previous_artifact_id = TRUE source`, Number(op.previous_artifact_id) === sourceId);
                if (familyKey === "oswadt-ifc4-model-requirements") {
                    check("6.5 IDS row does NOT self-reference its own target (the originally reproduced defect)", Number(op.previous_artifact_id) !== targetId);
                }
            }
        }
        // ---- TEST 7: target complete WITHOUT prior truthful triplet evidence -> fails closed ----
        console.log("  [7] real InnoDB: target already complete via ANOTHER mechanism, no prior triplet evidence -> fails closed");
        {
            // State after test 6 is fully on target, WITH truthful triplet evidence. Remove that
            // evidence (simulating "activated by some other/historical mechanism") while leaving
            // the current pointers on target — exactly the untested edge case.
            await conn.query(`DELETE FROM semantic_artifact_load_operations WHERE idempotency_key LIKE 'ifc4x3-triplet-activation:%'`);
            const beforeCount = await scalar(conn, `SELECT COUNT(*) FROM semantic_artifact_load_operations WHERE idempotency_key LIKE 'ifc4x3-triplet-activation:%'`);
            check("7.0 no prior triplet operation evidence exists", Number(beforeCount) === 0);

            const service = new Ifc4x3TripletActivationService(new SemanticArtifactDatabase());
            let code = "";
            try { await service.activateGovernedTargetSet(); } catch (e: any) { code = e?.code ?? ""; }
            check("7.1 fails closed (activation_conflict)", code === "activation_conflict");

            const selfRef = await scalar(conn, `
                SELECT COUNT(*) FROM semantic_artifact_load_operations
                WHERE idempotency_key LIKE 'ifc4x3-triplet-activation:%' AND status='completed' AND previous_artifact_id = artifact_id
            `);
            check("7.2 no fabricated self-referential completed evidence", Number(selfRef) === 0);
            const completedCount = await scalar(conn, `SELECT COUNT(*) FROM semantic_artifact_load_operations WHERE idempotency_key LIKE 'ifc4x3-triplet-activation:%' AND status='completed'`);
            check("7.3 no triplet operation was marked completed without truthful evidence", Number(completedCount) === 0);
        }

        // ---- TEST 8: normal source -> successful triplet activation -> rerun stays idempotent ----
        console.log("  [8] real InnoDB: source -> successful activation -> rerun remains idempotent with truthful evidence");
        {
            await conn.query(`DELETE FROM semantic_artifact_load_operations WHERE idempotency_key LIKE 'ifc4x3-triplet-activation:%'`);
            await resetToBaseline(conn, info);

            const service1 = new Ifc4x3TripletActivationService(new SemanticArtifactDatabase());
            const result1 = await service1.activateGovernedTargetSet();
            check("8.1 first activation succeeds", result1.status === "activated");

            const uuidsBefore: string[] = [];
            for (const familyKey of FAMILY_KEYS) {
                const { sourceId } = info[familyKey]!;
                const op = await firstRow(conn, `SELECT operation_uuid, previous_artifact_id FROM semantic_artifact_load_operations WHERE idempotency_key=?`, [`ifc4x3-triplet-activation:${TARGET_VERSION}:${familyKey}`]);
                check(`8.2 ${familyKey} truthful predecessor after first activation`, Number(op.previous_artifact_id) === sourceId);
                uuidsBefore.push(op.operation_uuid);
            }

            const service2 = new Ifc4x3TripletActivationService(new SemanticArtifactDatabase());
            const result2 = await service2.activateGovernedTargetSet();
            check("8.3 rerun is already_active", result2.status === "already_active");

            let uuidIdx = 0;
            for (const familyKey of FAMILY_KEYS) {
                const { sourceId } = info[familyKey]!;
                const op = await firstRow(conn, `SELECT operation_uuid, previous_artifact_id FROM semantic_artifact_load_operations WHERE idempotency_key=?`, [`ifc4x3-triplet-activation:${TARGET_VERSION}:${familyKey}`]);
                check(`8.4 ${familyKey} same operation UUID reused`, op.operation_uuid === uuidsBefore[uuidIdx]);
                check(`8.5 ${familyKey} predecessor unchanged by the rerun`, Number(op.previous_artifact_id) === sourceId);
                uuidIdx++;
            }
        }

        // ---- TEST 9: two concurrent callers from source, re-confirmed with the new evidence check ----
        console.log("  [9] real InnoDB: two concurrent callers from source -> winner activated, serialized loser accepts truthful evidence");
        {
            await conn.query(`DELETE FROM semantic_artifact_load_operations WHERE idempotency_key LIKE 'ifc4x3-triplet-activation:%'`);
            await resetToBaseline(conn, info);

            const serviceA = new Ifc4x3TripletActivationService(new SemanticArtifactDatabase());
            const serviceB = new Ifc4x3TripletActivationService(new SemanticArtifactDatabase());
            const [a, b] = await Promise.allSettled([serviceA.activateGovernedTargetSet(), serviceB.activateGovernedTargetSet()]);
            const outcomes = [a, b].map((r) => r.status === "fulfilled" ? r.value.status : `rejected:${(r as PromiseRejectedResult).reason?.code ?? (r as PromiseRejectedResult).reason?.message}`);
            console.log(`    observed outcomes: ${JSON.stringify(outcomes)}`);
            check("9.1 winner activated, serialized second caller already_active", JSON.stringify([...outcomes].sort()) === JSON.stringify(["activated", "already_active"]));

            for (const familyKey of FAMILY_KEYS) {
                const { familyId, sourceId, targetId } = info[familyKey]!;
                check(`9.2 ${familyKey} final pointer on target`, Number(await scalar(conn, `SELECT current_artifact_id FROM semantic_artifact_families WHERE id=?`, [familyId])) === targetId);
                const op = await firstRow(conn, `SELECT previous_artifact_id FROM semantic_artifact_load_operations WHERE idempotency_key=?`, [`ifc4x3-triplet-activation:${TARGET_VERSION}:${familyKey}`]);
                check(`9.3 ${familyKey} truthful predecessor after concurrent race`, Number(op.previous_artifact_id) === sourceId);
            }
        }
    } finally {
        await conn.end();
        await server.query(`DROP DATABASE \`${schema}\``);
        const [stillExists]: any = await server.query(`SELECT SCHEMA_NAME FROM information_schema.schemata WHERE SCHEMA_NAME=?`, [schema]);
        const [operationalStillExists]: any = await server.query(`SELECT SCHEMA_NAME FROM information_schema.schemata WHERE SCHEMA_NAME=?`, [operationalDb]);
        console.log(JSON.stringify({
            event: "ifc4x3_triplet_selftest_end",
            disposableSchemaDropped: schema, disposableSchemaStillExists: stillExists.length > 0,
            operationalDatabaseStillExists: operationalStillExists.length > 0, failures,
        }));
        await server.end();
    }
    // Every SemanticArtifactDatabase instance created above opened its own mysql2 pool
    // against the (now-dropped) disposable schema; those pools otherwise keep the process
    // alive indefinitely. Exit explicitly once results are final.
    process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
