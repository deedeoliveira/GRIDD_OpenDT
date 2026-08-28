/**
 * Disposable-schema self-test for RZ-2B1's read-only ReservationZone identity
 * snapshot loader (back/utils/reservationZoneIdentityDatabase.ts).
 *
 * Reuses the EXACT disposable-schema pattern established by
 * back/scripts/reservationZoneSchemaMigrationSelfTest.ts (RZ-2A1): a unique
 * throwaway schema on the configured MySQL SERVER (never DB_NAME/digital_twin),
 * applies the REAL RZ-2A1 migration to it, seeds fixture rows, and PROVES the
 * loader is genuinely read-only by comparing full before/after row counts AND
 * content (JSON-stable) of all four RZ-2A1 tables around every loader call.
 * The disposable schema is ALWAYS dropped afterwards.
 *
 * Intentionally NOT part of `npm test` (matches the established TAG-1 /
 * space-identity / RZ-2A1 self-test convention — no test-suite MySQL dependency).
 *
 * Usage (safe): npx tsx scripts/reservationZoneIdentitySnapshotSelfTest.ts
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const MIG_DIR = path.resolve(import.meta.dirname, '../../database/migrations');
const FORWARD = path.join(MIG_DIR, '2026-08-25_reservation_zone_schema.sql');

function splitStatements(sql: string): string[] {
  return sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}
async function applyMigration(conn: mysql.Connection, file: string): Promise<void> {
  for (const statement of splitStatements(fs.readFileSync(file, 'utf-8'))) {
    await conn.query(statement);
  }
}

let failures = 0;
function check(name: string, condition: boolean, detail = '') {
  if (condition) console.log(`    PASS  ${name}`);
  else { failures += 1; console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
async function scalar(conn: mysql.Connection, sql: string, params: any[] = []): Promise<any> {
  const [rows]: any = await conn.query(sql, params);
  const row = rows[0] ?? {};
  return row[Object.keys(row)[0] as string];
}

async function buildUpstreamSchema(conn: mysql.Connection) {
  await conn.query(`CREATE TABLE linked_models (id INT PRIMARY KEY AUTO_INCREMENT)`);
  await conn.query(`CREATE TABLE models (id INT PRIMARY KEY AUTO_INCREMENT, linked_parent_id INT,
    CONSTRAINT fk_m_lm FOREIGN KEY (linked_parent_id) REFERENCES linked_models(id))`);
  await conn.query(`CREATE TABLE model_versions (id INT PRIMARY KEY AUTO_INCREMENT, model_id INT,
    CONSTRAINT fk_mv_m FOREIGN KEY (model_id) REFERENCES models(id))`);
  await conn.query(`CREATE TABLE spaces (
    id INT PRIMARY KEY AUTO_INCREMENT, space_uuid CHAR(36) NOT NULL,
    inventory_code VARCHAR(200) NOT NULL, linked_model_id INT NOT NULL,
    CONSTRAINT fk_s_lm FOREIGN KEY (linked_model_id) REFERENCES linked_models(id))`);
}

const G1 = '0AAAAAAAAAAAAAAAAAAAA1';
const G2 = '0AAAAAAAAAAAAAAAAAAAA2';
const G3 = '0AAAAAAAAAAAAAAAAAAAA3'; // unknown, incoming
const G_OTHER_LINEAGE = '0AAAAAAAAAAAAAAAAAAAA1'; // same exact GID, different lineage (item 32)

const TABLES = ['reservation_zones', 'reservation_zone_bindings', 'reservation_zone_space_references', 'reservation_zone_guid_registry'];

async function snapshotTables(conn: mysql.Connection): Promise<Record<string, any[]>> {
  const out: Record<string, any[]> = {};
  for (const t of TABLES) {
    const [rows]: any = await conn.query(`SELECT * FROM \`${t}\` ORDER BY id`);
    out[t] = rows;
  }
  return out;
}

async function main() {
  const operationalDb = process.env.DB_NAME;
  const schema = `oswadt_rz2b1_snaptest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  if (schema === operationalDb) throw new Error('refusing to reuse the operational database name');
  const baseConfig = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, multipleStatements: false } as any;
  const server = await mysql.createConnection(baseConfig);
  console.log(JSON.stringify({ event: 'rz2b1_snapshot_self_test_start', disposableSchema: schema, operationalDatabase: operationalDb, note: 'operational database is never selected or modified' }));
  await server.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
  const conn = await mysql.createConnection({ ...baseConfig, database: schema } as any);
  try {
    await buildUpstreamSchema(conn);
    await conn.query(`INSERT INTO linked_models (id) VALUES (1),(2)`);
    await conn.query(`INSERT INTO models (id, linked_parent_id) VALUES (1,1)`);
    await conn.query(`INSERT INTO model_versions (id, model_id) VALUES (1,1)`);
    await applyMigration(conn, FORWARD);
    console.log('  [apply] forward migration applied');

    // ---- fixture: lineage 1 has zones 1 (active, owns G1+G2), 2 (retired, owns nothing incoming) ----
    await conn.query(`INSERT INTO reservation_zones (id, reservation_zone_uuid, linked_model_id, current_name, status) VALUES
      (1,'11111111-1111-1111-1111-111111111111',1,'Zone Active',  'active'),
      (2,'22222222-2222-2222-2222-222222222222',1,'Zone Retired', 'retired'),
      (3,'33333333-3333-3333-3333-333333333333',1,'Zone Absent',  'absent')`);
    await conn.query(`INSERT INTO reservation_zone_guid_registry (linked_model_id, ifc_guid, reservation_zone_id) VALUES
      (1, ?, 1), (1, ?, 1)`, [G1, G2]);
    // Retired owner: register a GID to the retired zone too, so item 33 (retired status loaded) is exercised.
    const G_RETIRED_OWNER = '0AAAAAAAAAAAAAAAAAAABZ';
    await conn.query(`INSERT INTO reservation_zone_guid_registry (linked_model_id, ifc_guid, reservation_zone_id) VALUES
      (1, ?, 2)`, [G_RETIRED_OWNER]);
    // A binding exists for zone 1 in lineage 1 — proves the loader never needs it for ownership.
    await conn.query(`INSERT INTO reservation_zone_bindings
      (reservation_zone_id, model_version_id, ifc_entity_id, ifc_guid, name_snapshot, referenced_space_global_ids_snapshot)
      VALUES (1, 1, 500, ?, 'Zone Active v1', '[]')`, [G1]);

    // ---- lineage 2: a zone that happens to register the SAME exact GID as G1/lineage-1 (item 32) ----
    await conn.query(`INSERT INTO reservation_zones (id, reservation_zone_uuid, linked_model_id, current_name, status) VALUES
      (4,'44444444-4444-4444-4444-444444444444',2,'Other Lineage Zone','active')`);
    await conn.query(`INSERT INTO reservation_zone_guid_registry (linked_model_id, ifc_guid, reservation_zone_id) VALUES
      (2, ?, 4)`, [G_OTHER_LINEAGE]);

    const before = await snapshotTables(conn);

    // Point the loader's underlying pool at the disposable schema BEFORE the module
    // (which reads env vars at construction time, via MySQLDatabase) is ever imported.
    process.env.DB_HOST = baseConfig.host;
    process.env.DB_PORT = String(baseConfig.port);
    process.env.DB_USER = baseConfig.user;
    process.env.DB_PASSWORD = baseConfig.password;
    process.env.DB_NAME = schema;

    console.log('  [loader] invoking loadReservationZoneIdentitySnapshot against the disposable schema');
    const { ReservationZoneIdentityDatabase } = await import('../utils/reservationZoneIdentityDatabase.ts');
    const scopedLoader = new ReservationZoneIdentityDatabase();

    const snapshot = await scopedLoader.loadReservationZoneIdentitySnapshot({
      linkedModelId: 1,
      incomingGlobalIds: [G1, G2, G3],
    });

    const after = await snapshotTables(conn);

    // ---- 31. registry ownership loaded lineage-scoped ----
    check('31 registry maps G1 -> zone 1', snapshot.registryByGlobalId.get(G1) === 1, String(snapshot.registryByGlobalId.get(G1)));
    check('31 registry maps G2 -> zone 1', snapshot.registryByGlobalId.get(G2) === 1, String(snapshot.registryByGlobalId.get(G2)));
    check('31 registry has no entry for unknown G3', !snapshot.registryByGlobalId.has(G3));

    // ---- 32. same exact GlobalId in ANOTHER lineage does not match ----
    check('32 lineage 2\'s registration of the same exact GID as G1 is NOT visible when querying lineage 1',
      snapshot.registryByGlobalId.get(G1) === 1 && snapshot.registryByGlobalId.get(G1) !== 4);

    // ---- 33. active/absent/retired status loaded correctly ----
    check('33 zone 1 status active', snapshot.zoneStatusById.get(1) === 'active');
    check('33 zone 2 status retired', snapshot.zoneStatusById.get(2) === 'retired');
    check('33 zone 3 status absent', snapshot.zoneStatusById.get(3) === 'absent');

    // ---- 34. multi-GID ownership of one zone represented correctly ----
    check('34 both G1 and G2 resolve to the SAME zone id (1)', snapshot.registryByGlobalId.get(G1) === snapshot.registryByGlobalId.get(G2));

    // ---- 35. binding history is NOT required for ownership resolution ----
    // Proven structurally: the loader's SQL never references reservation_zone_bindings.
    const loaderSource = fs.readFileSync(path.resolve(import.meta.dirname, '../utils/reservationZoneIdentityDatabase.ts'), 'utf-8');
    check('35 loader source never queries reservation_zone_bindings',
      !/FROM\s+reservation_zone_bindings/i.test(loaderSource) && !/JOIN\s+reservation_zone_bindings/i.test(loaderSource));

    // ---- 36. loader performs no writes: before/after row-for-row equality on all 4 tables ----
    for (const t of TABLES) {
      check(`36 ${t} row count unchanged`, before[t]!.length === after[t]!.length,
        `before=${before[t]!.length} after=${after[t]!.length}`);
      check(`36 ${t} content byte-identical (JSON)`, JSON.stringify(before[t]) === JSON.stringify(after[t]));
    }
    // ---- loader source contains no mutating statements at all ----
    const forbidden = ['INSERT INTO', 'UPDATE ', 'DELETE FROM', 'DROP ', 'ALTER '];
    for (const kw of forbidden) {
      check(`36 loader source contains no "${kw.trim()}" statement`, !loaderSource.toUpperCase().includes(kw));
    }

    // ==================== ISSUE 2 — K, L, O: empty incoming GlobalId set ====================
    const beforeEmpty = await snapshotTables(conn);
    let emptyThrew = false;
    let emptySnapshot: any = null;
    try {
      emptySnapshot = await scopedLoader.loadReservationZoneIdentitySnapshot({ linkedModelId: 1, incomingGlobalIds: [] });
    } catch (e) {
      emptyThrew = true;
      console.error('  [empty-set] unexpected throw:', String((e as any)?.message ?? e));
    }
    const afterEmpty = await snapshotTables(conn);

    check('K snapshot loader with zero incoming GlobalIds succeeds (no exception)', !emptyThrew);
    check('K empty-input snapshot has an empty registryByGlobalId', emptySnapshot && emptySnapshot.registryByGlobalId.size === 0);
    // ---- L: no literal IN () was ever executed — proven structurally (the
    // loader source guards the (A) registry query behind
    // `if (validGlobalIds.length > 0)`) AND behaviourally (the call above,
    // against a real MySQL server, did not throw a SQL syntax error).
    check('L loader source guards the registry IN(...) query behind a non-empty-list check',
      /if\s*\(\s*validGlobalIds\.length\s*>\s*0\s*\)/.test(loaderSource));
    check('L empty-input call against real MySQL did not raise a SQL syntax error', !emptyThrew);

    // ---- O: all four RZ tables unchanged before/after the empty-input loader call ----
    for (const t of TABLES) {
      check(`O ${t} row count unchanged (empty-input case)`, beforeEmpty[t]!.length === afterEmpty[t]!.length,
        `before=${beforeEmpty[t]!.length} after=${afterEmpty[t]!.length}`);
      check(`O ${t} content byte-identical (empty-input case)`, JSON.stringify(beforeEmpty[t]) === JSON.stringify(afterEmpty[t]));
    }

    // ==================== ISSUE 3 — real-SQL fail-closed proof (option b) ====================
    // Build an ISOLATED corruption-simulation schema WITHOUT the composite FK
    // (fk_rzgr_zone_lineage), deliberately, to prove the loader's real
    // SQL-query-construction path also fails closed against a genuinely
    // cross-lineage-inconsistent registry row. Kept fully separate from the
    // normal RZ-2A1 self-test schema above — never used for anything else.
    const corruptSchema = `oswadt_rz2b1_corrupt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await server.query(`CREATE DATABASE \`${corruptSchema}\` CHARACTER SET utf8mb4`);
    const corruptConn = await mysql.createConnection({ ...baseConfig, database: corruptSchema } as any);
    try {
      await buildUpstreamSchema(corruptConn);
      await corruptConn.query(`INSERT INTO linked_models (id) VALUES (1)`);
      // Same table shapes as the real migration, MINUS fk_rzgr_zone_lineage —
      // clearly labeled as a corruption-simulation schema, never the real DDL.
      await corruptConn.query(`CREATE TABLE reservation_zones (
        id INT PRIMARY KEY AUTO_INCREMENT, reservation_zone_uuid CHAR(36) NOT NULL,
        linked_model_id INT NOT NULL, current_name VARCHAR(255) NOT NULL,
        status ENUM('active','absent','retired') NOT NULL DEFAULT 'active')`);
      await corruptConn.query(`CREATE TABLE reservation_zone_guid_registry (
        id INT PRIMARY KEY AUTO_INCREMENT, linked_model_id INT NOT NULL,
        ifc_guid CHAR(22) NOT NULL, reservation_zone_id INT NOT NULL)`); // NO composite FK — corruption-simulation only
      await corruptConn.query(`CREATE TABLE reservation_zone_bindings (id INT PRIMARY KEY AUTO_INCREMENT)`);
      await corruptConn.query(`CREATE TABLE reservation_zone_space_references (id INT PRIMARY KEY AUTO_INCREMENT)`);
      // Zone 99 belongs to a DIFFERENT lineage (2); lineage 1 has only zone 10.
      await corruptConn.query(`INSERT INTO reservation_zones (id, reservation_zone_uuid, linked_model_id, current_name, status) VALUES
        (10, '10101010-1010-1010-1010-101010101010', 1, 'Zone Ten', 'active'),
        (99, '99999999-9999-9999-9999-999999999999', 2, 'Zone Ninety-Nine', 'active')`);
      // Registry row scoped to lineage 1 but pointing at zone 99 (lineage 2) — the
      // cross-lineage-inconsistent state the real composite FK would prevent.
      await corruptConn.query(`INSERT INTO reservation_zone_guid_registry (linked_model_id, ifc_guid, reservation_zone_id) VALUES
        (1, ?, 99)`, [G3]);

      process.env.DB_NAME = corruptSchema;
      // Reuse the class already imported above (module caching means a fresh
      // dynamic import would return the same instance anyway); MySQLDatabase
      // reads env vars at ITS OWN construction time, so a new instance here
      // correctly targets the corrupt schema.
      const corruptLoader = new ReservationZoneIdentityDatabase();
      let integrityThrew = false;
      let integrityErrorCode: string | undefined;
      try {
        await corruptLoader.loadReservationZoneIdentitySnapshot({ linkedModelId: 1, incomingGlobalIds: [G3] });
      } catch (e: any) {
        integrityThrew = true;
        integrityErrorCode = e?.code;
        console.log(`  [integrity] real-SQL corrupt-schema loader threw as expected: ${e?.name}(${e?.code})`);
      }
      check('14b real-SQL cross-lineage-inconsistent registry row makes the loader fail closed', integrityThrew);
      check('14b failure carries code registry_owner_missing_lineage_scoped_zone', integrityErrorCode === 'registry_owner_missing_lineage_scoped_zone');
    } finally {
      await corruptConn.end();
      await server.query(`DROP DATABASE \`${corruptSchema}\``);
    }
  } finally {
    await conn.end();
    await server.query(`DROP DATABASE \`${schema}\``);
    console.log(JSON.stringify({ event: 'rz2b1_snapshot_self_test_end', disposableSchemaDropped: schema, failures }));
    await server.end();
  }
  // Force-exit: the module under test's default-exported singleton
  // (ReservationZoneIdentityDatabase's own top-level `new ...()` — a
  // side-effecting module-load convention shared with spaceDatabase.ts /
  // persistentAssetDatabase.ts) opens its own MySQL pool that would otherwise
  // keep the event loop alive indefinitely.
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
