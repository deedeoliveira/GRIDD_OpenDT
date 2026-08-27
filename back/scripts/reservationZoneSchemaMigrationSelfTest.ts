/**
 * Disposable-schema self-test for the RZ-2A1 ReservationZone schema-only migration:
 *   database/migrations/2026-08-25_reservation_zone_schema.sql (+ rollback).
 *
 * Creates a brand-new throwaway schema on the configured MySQL SERVER (NEVER the
 * operational database named by DB_NAME), builds the minimal upstream tables the
 * new FKs point at (linked_models, model_versions via models, spaces), runs the
 * REAL forward + rollback SQL files, and proves the schema invariants A–V plus
 * index/collation/CHECK introspection. The disposable schema is ALWAYS dropped
 * afterwards; digital_twin is never selected or modified.
 *
 * This is intentionally NOT part of `npm test` (matches the established
 * TAG-1 / space-identity / ifc4x3-space-semantics self-test convention).
 *
 * Usage (safe): npx tsx scripts/reservationZoneSchemaMigrationSelfTest.ts
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const MIG_DIR = path.resolve(import.meta.dirname, '../../database/migrations');
const FORWARD = path.join(MIG_DIR, '2026-08-25_reservation_zone_schema.sql');
const ROLLBACK = path.join(MIG_DIR, '2026-08-25_reservation_zone_schema_rollback.sql');

function splitStatements(sql: string): string[] {
  return sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}
async function applyMigration(conn: mysql.Connection, file: string): Promise<void> {
  for (const statement of splitStatements(fs.readFileSync(file, 'utf-8'))) {
    try { await conn.query(statement); }
    catch (error) { try { await conn.query('ROLLBACK'); } catch { /* none */ } throw error; }
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
async function tableExists(conn: mysql.Connection, schema: string, table: string): Promise<boolean> {
  return Number(await scalar(conn,
    `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=? AND table_name=?`,
    [schema, table])) > 0;
}
async function indexExists(conn: mysql.Connection, schema: string, table: string, index: string): Promise<boolean> {
  return Number(await scalar(conn,
    `SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=? AND table_name=? AND index_name=?`,
    [schema, table, index])) > 0;
}
async function indexIsUnique(conn: mysql.Connection, schema: string, table: string, index: string): Promise<boolean> {
  return Number(await scalar(conn,
    `SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=? AND table_name=? AND index_name=? AND non_unique=0`,
    [schema, table, index])) > 0;
}
async function columnMeta(conn: mysql.Connection, schema: string, table: string, column: string): Promise<any> {
  const [rows]: any = await conn.query(
    `SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH AS len, CHARACTER_SET_NAME AS cs, COLLATION_NAME AS coll, IS_NULLABLE AS nullable
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?`,
    [schema, table, column]);
  return rows[0];
}
async function expectError(fn: () => Promise<any>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
}

async function buildUpstreamSchema(conn: mysql.Connection) {
  await conn.query(`CREATE TABLE linked_models (id INT PRIMARY KEY AUTO_INCREMENT)`);
  await conn.query(`CREATE TABLE models (id INT PRIMARY KEY AUTO_INCREMENT, linked_parent_id INT,
    CONSTRAINT fk_m_lm FOREIGN KEY (linked_parent_id) REFERENCES linked_models(id))`);
  await conn.query(`CREATE TABLE model_versions (id INT PRIMARY KEY AUTO_INCREMENT, model_id INT,
    CONSTRAINT fk_mv_m FOREIGN KEY (model_id) REFERENCES models(id))`);
  // Minimal spaces table (real shape from 2026-07-16_space_identity.sql), needed only
  // as the FK target for reservation_zone_space_references.space_id.
  await conn.query(`CREATE TABLE spaces (
    id INT PRIMARY KEY AUTO_INCREMENT, space_uuid CHAR(36) NOT NULL,
    inventory_code VARCHAR(200) NOT NULL, linked_model_id INT NOT NULL,
    CONSTRAINT fk_s_lm FOREIGN KEY (linked_model_id) REFERENCES linked_models(id))`);
}

async function seed(conn: mysql.Connection) {
  await conn.query(`INSERT INTO linked_models (id) VALUES (1),(2)`);
  await conn.query(`INSERT INTO models (id, linked_parent_id) VALUES (1,1),(2,2)`);
  await conn.query(`INSERT INTO model_versions (id, model_id) VALUES (1,1),(2,1),(3,2)`);
  await conn.query(`INSERT INTO spaces (id, space_uuid, inventory_code, linked_model_id) VALUES
    (1,'su1','R-101',1),(2,'su2','R-102',1)`);
}

const VALID_GUID_1 = '0AAAAAAAAAAAAAAAAAAAA1';
const VALID_GUID_1_LOWER = '0aaaaaaaaaaaaaaaaaaaa1';
const VALID_GUID_2 = '0AAAAAAAAAAAAAAAAAAAA2';
const INVALID_GUID = 'not-a-valid-guid!!!!!'; // 22 chars but disallowed alphabet

async function main() {
  const operationalDb = process.env.DB_NAME;
  const schema = `oswadt_rz2a1_migtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  if (schema === operationalDb) throw new Error('refusing to reuse the operational database name');
  const baseConfig = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, multipleStatements: false } as any;
  const server = await mysql.createConnection(baseConfig);
  console.log(JSON.stringify({ event: 'rz2a1_self_test_start', disposableSchema: schema, operationalDatabase: operationalDb, note: 'operational database is never selected or modified' }));
  await server.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
  const conn = await mysql.createConnection({ ...baseConfig, database: schema } as any);
  try {
    await buildUpstreamSchema(conn);
    await seed(conn);

    // ---- forward apply ----
    await applyMigration(conn, FORWARD);
    console.log('  [apply] forward migration applied');

    // ---- A. four tables created ----
    console.log('  [A] table set');
    check('A1 reservation_zones exists', await tableExists(conn, schema, 'reservation_zones'));
    check('A2 reservation_zone_bindings exists', await tableExists(conn, schema, 'reservation_zone_bindings'));
    check('A3 reservation_zone_space_references exists', await tableExists(conn, schema, 'reservation_zone_space_references'));
    check('A4 reservation_zone_guid_registry exists', await tableExists(conn, schema, 'reservation_zone_guid_registry'));
    check('A5 no reconciliation table', !(await tableExists(conn, schema, 'reservation_zone_reconciliation_cases')));

    // Seed one zone to hang bindings off.
    await conn.query(`INSERT INTO reservation_zones (id, reservation_zone_uuid, linked_model_id, current_name) VALUES
      (1,'11111111-1111-1111-1111-111111111111',1,'Zone A'),
      (2,'22222222-2222-2222-2222-222222222222',1,'Zone B')`);

    // ---- B. reservation_zone_uuid UNIQUE ----
    console.log('  [B] reservation_zone_uuid UNIQUE');
    check('B1 duplicate uuid rejected', await expectError(() =>
      conn.query(`INSERT INTO reservation_zones (reservation_zone_uuid, linked_model_id, current_name) VALUES
        ('11111111-1111-1111-1111-111111111111', 1, 'Dup')`)));

    // ---- C. linked_model FK works ----
    console.log('  [C] linked_model FK');
    check('C1 invalid linked_model_id rejected', await expectError(() =>
      conn.query(`INSERT INTO reservation_zones (reservation_zone_uuid, linked_model_id, current_name) VALUES
        ('33333333-3333-3333-3333-333333333333', 9999, 'X')`)));

    // ---- D. current_name rejects NULL ----
    console.log('  [D] current_name NOT NULL');
    check('D1 NULL current_name rejected', await expectError(() =>
      conn.query(`INSERT INTO reservation_zones (reservation_zone_uuid, linked_model_id, current_name) VALUES
        ('44444444-4444-4444-4444-444444444444', 1, NULL)`)));

    // ---- E. name_snapshot rejects NULL (binding) ----
    console.log('  [E] name_snapshot NOT NULL');
    check('E1 NULL name_snapshot rejected', await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_bindings
        (reservation_zone_id, model_version_id, ifc_entity_id, ifc_guid, name_snapshot, referenced_space_global_ids_snapshot)
        VALUES (1, 1, 101, ?, NULL, '[]')`, [VALID_GUID_1])));

    // ---- F/G. status ENUM ----
    console.log('  [F/G] status ENUM');
    await conn.query(`INSERT INTO reservation_zones (reservation_zone_uuid, linked_model_id, current_name, status) VALUES
      ('55555555-5555-5555-5555-555555555555', 1, 'Zone C', 'absent')`);
    await conn.query(`INSERT INTO reservation_zones (reservation_zone_uuid, linked_model_id, current_name, status) VALUES
      ('66666666-6666-6666-6666-666666666666', 1, 'Zone D', 'retired')`);
    check('F1 active/absent/retired accepted', true);
    check('G1 invalid status rejected', await expectError(() =>
      conn.query(`INSERT INTO reservation_zones (reservation_zone_uuid, linked_model_id, current_name, status) VALUES
        ('77777777-7777-7777-7777-777777777777', 1, 'Zone E', 'bogus')`)));

    // ---- H. same ifc_entity_id in DIFFERENT model_version_id: allowed ----
    console.log('  [H] cross-version same entity id allowed');
    await conn.query(`INSERT INTO reservation_zone_bindings
      (reservation_zone_id, model_version_id, ifc_entity_id, ifc_guid, name_snapshot, referenced_space_global_ids_snapshot)
      VALUES (1, 1, 500, ?, 'Zone A v1', '[]')`, [VALID_GUID_1]);
    check('H1 same entity id, different version, allowed', !(await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_bindings
        (reservation_zone_id, model_version_id, ifc_entity_id, ifc_guid, name_snapshot, referenced_space_global_ids_snapshot)
        VALUES (2, 2, 500, ?, 'Zone B v2', '[]')`, [VALID_GUID_2]))));

    // ---- I. same model_version_id + same ifc_entity_id: rejected ----
    console.log('  [I] same version+entity rejected');
    check('I1 duplicate (version,entity) rejected', await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_bindings
        (reservation_zone_id, model_version_id, ifc_entity_id, ifc_guid, name_snapshot, referenced_space_global_ids_snapshot)
        VALUES (2, 1, 500, ?, 'Other', '[]')`, [VALID_GUID_2])));

    // ---- J. same reservation_zone_id + same model_version_id: rejected ----
    console.log('  [J] same zone+version rejected');
    check('J1 duplicate (zone,version) rejected', await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_bindings
        (reservation_zone_id, model_version_id, ifc_entity_id, ifc_guid, name_snapshot, referenced_space_global_ids_snapshot)
        VALUES (1, 1, 999, ?, 'Other', '[]')`, [VALID_GUID_2])));

    // ---- K. same ifc_guid across different versions: allowed (already true via H) ----
    console.log('  [K] same ifc_guid across versions allowed');
    check('K1 confirmed via H (guid ' + VALID_GUID_1 + ' bound in v1, ' + VALID_GUID_2 + ' distinct in v2; now add v3 reusing guid1)', true);
    await conn.query(`INSERT INTO reservation_zone_bindings
      (reservation_zone_id, model_version_id, ifc_entity_id, ifc_guid, name_snapshot, referenced_space_global_ids_snapshot)
      VALUES (2, 3, 501, ?, 'Zone B v3', '[]')`, [VALID_GUID_1]);
    check('K2 ifc_guid reused in a third version accepted', true);

    // ---- L. duplicate GlobalId within ONE version NOT rejected by a UNIQUE(ifc_guid) ----
    console.log('  [L] duplicate ifc_guid within one version allowed (no ifc_guid UNIQUE)');
    check('L1 two bindings same version, same ifc_guid, different entity id: accepted', !(await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_bindings
        (reservation_zone_id, model_version_id, ifc_entity_id, ifc_guid, name_snapshot, referenced_space_global_ids_snapshot)
        VALUES (2, 1, 777, ?, 'Dup guid same version', '[]')`, [VALID_GUID_1]))));

    // ---- M. registry same lineage + same GlobalId cannot point to two zones ----
    console.log('  [M] registry same lineage+guid conflict rejected');
    await conn.query(`INSERT INTO reservation_zone_guid_registry (linked_model_id, ifc_guid, reservation_zone_id) VALUES
      (1, ?, 1)`, [VALID_GUID_1]);
    check('M1 conflicting (linked_model,guid) rejected', await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_guid_registry (linked_model_id, ifc_guid, reservation_zone_id) VALUES
        (1, ?, 2)`, [VALID_GUID_1])));

    // ---- N. registry same GlobalId in DIFFERENT linked_model_id lineages: allowed,
    // as long as it points to a zone that actually belongs to that lineage ----
    console.log('  [N] registry same guid different lineage allowed (lineage-correct zone)');
    await conn.query(`INSERT INTO reservation_zones (id, reservation_zone_uuid, linked_model_id, current_name) VALUES
      (3,'33333333-cccc-cccc-cccc-333333333333',2,'Zone C (lineage 2)')`);
    check('N1 same guid, different linked_model_id, pointing to a zone of THAT lineage, accepted', !(await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_guid_registry (linked_model_id, ifc_guid, reservation_zone_id) VALUES
        (2, ?, 3)`, [VALID_GUID_1]))));

    // ---- O. registry GlobalIds differing only by case: distinct (ascii_bin) ----
    console.log('  [O] registry case-sensitivity (ascii_bin)');
    check('O1 case-varied guid in same lineage accepted as distinct row', !(await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_guid_registry (linked_model_id, ifc_guid, reservation_zone_id) VALUES
        (1, ?, 2)`, [VALID_GUID_1_LOWER]))));

    // ---- P. invalid compressed GlobalId in registry: rejected ----
    console.log('  [P] invalid guid format rejected by CHECK');
    check('P1 invalid alphabet guid rejected', await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_guid_registry (linked_model_id, ifc_guid, reservation_zone_id) VALUES
        (2, ?, 1)`, [INVALID_GUID])));

    // ---- Q/R. binding snapshot NULL rejected, "[]" accepted ----
    console.log('  [Q/R] snapshot nullability + empty-array literal');
    check('Q1 NULL snapshot rejected', await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_bindings
        (reservation_zone_id, model_version_id, ifc_entity_id, ifc_guid, name_snapshot, referenced_space_global_ids_snapshot)
        VALUES (1, 2, 900, ?, 'X', NULL)`, [VALID_GUID_2])));
    check('R1 "[]" snapshot accepted (already used throughout: e.g. H1 row)', true);

    // ---- S/T/U/V. space references ----
    console.log('  [S-V] space references');
    const bindingIdRow: any = await conn.query(`SELECT id FROM reservation_zone_bindings WHERE reservation_zone_id=1 AND model_version_id=1`);
    const bindingId = (bindingIdRow[0] as any[])[0].id;
    const bindingId2Row: any = await conn.query(`SELECT id FROM reservation_zone_bindings WHERE reservation_zone_id=2 AND model_version_id=2`);
    const bindingId2 = (bindingId2Row[0] as any[])[0].id;

    await conn.query(`INSERT INTO reservation_zone_space_references (binding_id, space_id) VALUES (?, 1)`, [bindingId]);
    // S. same binding+space pair rejected
    check('S1 duplicate (binding,space) rejected', await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_space_references (binding_id, space_id) VALUES (?, 1)`, [bindingId])));
    // T. same space referenced by different bindings: allowed
    check('T1 same space referenced by a different binding accepted', !(await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_space_references (binding_id, space_id) VALUES (?, 1)`, [bindingId2]))));
    // U. one binding may reference multiple spaces
    check('U1 one binding referencing a second space accepted', !(await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_space_references (binding_id, space_id) VALUES (?, 2)`, [bindingId]))));
    // V. zero space-reference rows for a binding is valid (bindingId2 for zone2/version2 already has 1 row from T1;
    // check a fresh binding with zero rows is fine by simply not inserting for one — proven structurally, no
    // constraint prevents it; assert count is possible to be zero via a fresh binding row)
    await conn.query(`INSERT INTO reservation_zone_bindings
      (reservation_zone_id, model_version_id, ifc_entity_id, ifc_guid, name_snapshot, referenced_space_global_ids_snapshot)
      VALUES (1, 2, 1500, ?, 'No refs', '[]')`, [VALID_GUID_2]);
    const zeroRefBindingRow: any = await conn.query(`SELECT id FROM reservation_zone_bindings WHERE ifc_entity_id=1500`);
    const zeroRefBindingId = (zeroRefBindingRow[0] as any[])[0].id;
    const refCount = Number(await scalar(conn, `SELECT COUNT(*) FROM reservation_zone_space_references WHERE binding_id=?`, [zeroRefBindingId]));
    check('V1 zero space-reference rows for a binding is valid', refCount === 0);

    // ---- index introspection ----
    console.log('  [index] reservation_zone_bindings');
    check('idx1 uq_rzb_zone_version present+unique', await indexIsUnique(conn, schema, 'reservation_zone_bindings', 'uq_rzb_zone_version'));
    check('idx2 uq_rzb_version_entity present+unique', await indexIsUnique(conn, schema, 'reservation_zone_bindings', 'uq_rzb_version_entity'));
    check('idx3 idx_rzb_guid present', await indexExists(conn, schema, 'reservation_zone_bindings', 'idx_rzb_guid'));
    check('idx4 no redundant standalone idx_rzb_version', !(await indexExists(conn, schema, 'reservation_zone_bindings', 'idx_rzb_version')));

    console.log('  [index] reservation_zone_space_references');
    check('idx5 uq_rzsr_binding_space present+unique', await indexIsUnique(conn, schema, 'reservation_zone_space_references', 'uq_rzsr_binding_space'));
    check('idx6 no redundant standalone binding_id-only index', !(await indexExists(conn, schema, 'reservation_zone_space_references', 'idx_rzsr_binding')));
    check('idx6b idx_rzsr_space explicit FK-support index present', await indexExists(conn, schema, 'reservation_zone_space_references', 'idx_rzsr_space'));
    {
      const [rows]: any = await conn.query(`SHOW INDEX FROM \`reservation_zone_space_references\` WHERE Key_name='idx_rzsr_space'`);
      check('idx6c idx_rzsr_space exists exactly once, single-column (space_id)', rows.length === 1 && rows[0].Column_name === 'space_id', JSON.stringify(rows));
      const [allRows]: any = await conn.query(`SHOW INDEX FROM \`reservation_zone_space_references\``);
      const spaceIdLeadingIndexes = new Set((allRows as any[]).filter((r) => r.Seq_in_index === 1 && r.Column_name === 'space_id').map((r) => r.Key_name));
      check('idx6d exactly one index leads with space_id (no engine-generated duplicate)', spaceIdLeadingIndexes.size === 1 && spaceIdLeadingIndexes.has('idx_rzsr_space'), JSON.stringify([...spaceIdLeadingIndexes]));
      check('idx6e no auto-generated fk_rzsr_space-named index remains (explicit key took over FK support)', !(await indexExists(conn, schema, 'reservation_zone_space_references', 'fk_rzsr_space')));
    }

    console.log('  [index] reservation_zone_guid_registry');
    check('idx7 uq_rzgr_model_guid present+unique', await indexIsUnique(conn, schema, 'reservation_zone_guid_registry', 'uq_rzgr_model_guid'));
    check('idx8 no standalone ifc_guid-only index', !(await indexExists(conn, schema, 'reservation_zone_guid_registry', 'idx_rzgr_guid')));
    check('idx8b idx_rzgr_zone_lineage explicit FK-support index present', await indexExists(conn, schema, 'reservation_zone_guid_registry', 'idx_rzgr_zone_lineage'));
    {
      const [rowsRaw]: any = await conn.query(`SHOW INDEX FROM \`reservation_zone_guid_registry\` WHERE Key_name='idx_rzgr_zone_lineage'`);
      const rows = [...rowsRaw].sort((a: any, b: any) => a.Seq_in_index - b.Seq_in_index);
      check('idx8c idx_rzgr_zone_lineage exists exactly once, columns (linked_model_id, reservation_zone_id) in order',
        rows.length === 2 && rows[0].Column_name === 'linked_model_id' && rows[1].Column_name === 'reservation_zone_id', JSON.stringify(rows));
      const [allRows]: any = await conn.query(`SHOW INDEX FROM \`reservation_zone_guid_registry\``);
      const lineageLeadingIndexes = new Set((allRows as any[]).filter((r) => r.Seq_in_index === 1 && r.Column_name === 'linked_model_id').map((r) => r.Key_name));
      check('idx8d exactly the two intended indexes lead with linked_model_id (uq_rzgr_model_guid, idx_rzgr_zone_lineage) — no engine-generated duplicate',
        lineageLeadingIndexes.size === 2 && lineageLeadingIndexes.has('uq_rzgr_model_guid') && lineageLeadingIndexes.has('idx_rzgr_zone_lineage'), JSON.stringify([...lineageLeadingIndexes]));
      check('idx8e no auto-generated fk_rzgr_zone_lineage-named index remains (explicit key took over FK support)', !(await indexExists(conn, schema, 'reservation_zone_guid_registry', 'fk_rzgr_zone_lineage')));
    }

    // ---- collation introspection (deployed schema, not source text) ----
    console.log('  [collation] deployed column metadata');
    const registryGuidMeta = await columnMeta(conn, schema, 'reservation_zone_guid_registry', 'ifc_guid');
    check('col1 registry.ifc_guid CHAR(22)', registryGuidMeta.DATA_TYPE === 'char' && Number(registryGuidMeta.len) === 22,
      JSON.stringify(registryGuidMeta));
    check('col2 registry.ifc_guid charset ascii', registryGuidMeta.cs === 'ascii', JSON.stringify(registryGuidMeta));
    check('col3 registry.ifc_guid collation ascii_bin', registryGuidMeta.coll === 'ascii_bin', JSON.stringify(registryGuidMeta));
    check('col4 registry.ifc_guid NOT NULL', registryGuidMeta.nullable === 'NO', JSON.stringify(registryGuidMeta));

    const bindingGuidMeta = await columnMeta(conn, schema, 'reservation_zone_bindings', 'ifc_guid');
    check('col5 binding.ifc_guid VARCHAR(100)', bindingGuidMeta.DATA_TYPE === 'varchar' && Number(bindingGuidMeta.len) === 100, JSON.stringify(bindingGuidMeta));
    check('col6 binding.ifc_guid charset ascii', bindingGuidMeta.cs === 'ascii', JSON.stringify(bindingGuidMeta));
    check('col7 binding.ifc_guid collation ascii_bin', bindingGuidMeta.coll === 'ascii_bin', JSON.stringify(bindingGuidMeta));
    check('col8 binding.ifc_guid NOT NULL', bindingGuidMeta.nullable === 'NO', JSON.stringify(bindingGuidMeta));

    const uuidMeta = await columnMeta(conn, schema, 'reservation_zones', 'reservation_zone_uuid');
    check('col9 reservation_zone_uuid CHAR(36) NOT NULL', uuidMeta.DATA_TYPE === 'char' && Number(uuidMeta.len) === 36 && uuidMeta.nullable === 'NO', JSON.stringify(uuidMeta));

    // ---- CHECK clause introspection ----
    console.log('  [check] registry CHECK clause matches spaces.ifc_global_id semantics');
    const checkRow: any = await conn.query(
      `SELECT cc.CHECK_CLAUSE AS clause FROM information_schema.TABLE_CONSTRAINTS tc
         JOIN information_schema.CHECK_CONSTRAINTS cc
           ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = 'reservation_zone_guid_registry'
          AND tc.CONSTRAINT_NAME = 'chk_rzgr_ifc_guid_format' AND tc.CONSTRAINT_TYPE = 'CHECK'`, [schema]);
    const clause = String((checkRow[0] as any[])[0]?.clause ?? '');
    check('check1 CHECK uses the same [0-9A-Za-z_$]{22} alphabet as spaces.ifc_global_id', /\[0-9A-Za-z_\$\]\{22\}/.test(clause), clause);

    // ---- table_status/table set no reconciliation, no reservation-target table ----
    console.log('  [no-extra] no reconciliation/reservation-target table created');
    check('extra1 no reservation_zone_reconciliation_cases table', !(await tableExists(conn, schema, 'reservation_zone_reconciliation_cases')));

    // ---- W. registry cross-lineage integrity (composite FK fk_rzgr_zone_lineage) ----
    console.log('  [W] registry cross-lineage composite FK');
    // Zone 1 belongs to lineage (linked_model_id) 1. Zone 3 belongs to lineage 2 (seeded above in [N]).
    const W_GUID = '0AAAAAAAAAAAAAAAAAAAA9';
    const W_GUID_2 = '0AAAAAAAAAAAAAAAAAAABA';
    check('W1 lineage-correct registry row (L1+G->Z1, Z1 in L1) accepted', !(await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_guid_registry (linked_model_id, ifc_guid, reservation_zone_id) VALUES
        (1, ?, 1)`, [W_GUID]))));
    check('W2 lineage-mismatched registry row (L2+G2->Z1, Z1 in L1) rejected by fk_rzgr_zone_lineage', await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_guid_registry (linked_model_id, ifc_guid, reservation_zone_id) VALUES
        (2, ?, 1)`, [W_GUID_2])));
    const W3_GUID = '0AAAAAAAAAAAAAAAAAAABB';
    check('W3a same GlobalId as L1+G->Z1 accepted', !(await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_guid_registry (linked_model_id, ifc_guid, reservation_zone_id) VALUES
        (1, ?, 1)`, [W3_GUID]))));
    check('W3b SAME exact GlobalId also accepted as L2+G->Z3 (Z3 in L2)', !(await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_guid_registry (linked_model_id, ifc_guid, reservation_zone_id) VALUES
        (2, ?, 3)`, [W3_GUID]))));
    check('W4 same lineage + same GlobalId -> different zone rejected by uq_rzgr_model_guid', await expectError(() =>
      conn.query(`INSERT INTO reservation_zone_guid_registry (linked_model_id, ifc_guid, reservation_zone_id) VALUES
        (1, ?, 2)`, [W3_GUID])));

    // ---- index introspection: reservation_zones lineage composite ----
    console.log('  [index] reservation_zones lineage');
    check('idx9 uq_rz_lineage_id present+unique', await indexIsUnique(conn, schema, 'reservation_zones', 'uq_rz_lineage_id'));
    check('idx10 idx_rz_linked_model genuinely absent (redundant, removed)', !(await indexExists(conn, schema, 'reservation_zones', 'idx_rz_linked_model')));
    const lineageLookupExplain: any = await conn.query(`EXPLAIN SELECT * FROM reservation_zones WHERE linked_model_id = 1`);
    const explainRow = (lineageLookupExplain[0] as any[])[0];
    check('idx11 linked_model_id lookup still served by an index (leftmost prefix of uq_rz_lineage_id)',
      explainRow && explainRow.key != null && explainRow.key !== 'NULL', JSON.stringify(explainRow));

    // ---- FK introspection: registry FK set ----
    console.log('  [fk] reservation_zone_guid_registry FK set');
    const fkRows: any = await conn.query(
      `SELECT CONSTRAINT_NAME, COLUMN_NAME, ORDINAL_POSITION, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA=? AND TABLE_NAME='reservation_zone_guid_registry' AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`, [schema]);
    const fkList = fkRows[0] as any[];
    check('fk1 fk_rzgr_zone_lineage present', fkList.some((r) => r.CONSTRAINT_NAME === 'fk_rzgr_zone_lineage'), JSON.stringify(fkList));
    check('fk2 fk_rzgr_linked_model genuinely absent (redundant, removed)', !fkList.some((r) => r.CONSTRAINT_NAME === 'fk_rzgr_linked_model'), JSON.stringify(fkList));
    const zoneLineageFkCols = fkList.filter((r) => r.CONSTRAINT_NAME === 'fk_rzgr_zone_lineage').sort((a, b) => a.ORDINAL_POSITION - b.ORDINAL_POSITION);
    check('fk3 fk_rzgr_zone_lineage has exactly 2 columns', zoneLineageFkCols.length === 2, JSON.stringify(zoneLineageFkCols));
    check('fk4 fk_rzgr_zone_lineage col order: (linked_model_id, reservation_zone_id) -> (linked_model_id, id)',
      zoneLineageFkCols[0]?.COLUMN_NAME === 'linked_model_id' && zoneLineageFkCols[0]?.REFERENCED_COLUMN_NAME === 'linked_model_id' &&
      zoneLineageFkCols[1]?.COLUMN_NAME === 'reservation_zone_id' && zoneLineageFkCols[1]?.REFERENCED_COLUMN_NAME === 'id' &&
      zoneLineageFkCols[0]?.REFERENCED_TABLE_NAME === 'reservation_zones' && zoneLineageFkCols[1]?.REFERENCED_TABLE_NAME === 'reservation_zones',
      JSON.stringify(zoneLineageFkCols));

    const refConstraintRows: any = await conn.query(
      `SELECT CONSTRAINT_NAME, UPDATE_RULE, DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME='reservation_zone_guid_registry'`, [schema]);
    const refConstraints = refConstraintRows[0] as any[];
    const zoneLineageRule = refConstraints.find((r) => r.CONSTRAINT_NAME === 'fk_rzgr_zone_lineage');
    check('fk5 fk_rzgr_zone_lineage delete/update rule is the implicit default (NO ACTION/RESTRICT), no CASCADE/SET NULL',
      zoneLineageRule && ['NO ACTION', 'RESTRICT'].includes(zoneLineageRule.DELETE_RULE) && ['NO ACTION', 'RESTRICT'].includes(zoneLineageRule.UPDATE_RULE),
      JSON.stringify(zoneLineageRule));

    // ---- rollback ----
    console.log('  [rollback] applying rollback');
    await applyMigration(conn, ROLLBACK);
    check('rb1 reservation_zones removed', !(await tableExists(conn, schema, 'reservation_zones')));
    check('rb2 reservation_zone_bindings removed', !(await tableExists(conn, schema, 'reservation_zone_bindings')));
    check('rb3 reservation_zone_space_references removed', !(await tableExists(conn, schema, 'reservation_zone_space_references')));
    check('rb4 reservation_zone_guid_registry removed', !(await tableExists(conn, schema, 'reservation_zone_guid_registry')));
    check('rb5 unrelated schema intact (linked_models)', await tableExists(conn, schema, 'linked_models'));
    check('rb6 unrelated schema intact (model_versions)', await tableExists(conn, schema, 'model_versions'));
    check('rb7 unrelated schema intact (spaces)', await tableExists(conn, schema, 'spaces'));

    // ---- final sanity: re-apply forward migration ----
    console.log('  [reapply] final forward-state sanity check');
    await applyMigration(conn, FORWARD);
    check('reapply1 reservation_zones re-created', await tableExists(conn, schema, 'reservation_zones'));
    check('reapply2 reservation_zone_bindings re-created', await tableExists(conn, schema, 'reservation_zone_bindings'));
    check('reapply3 reservation_zone_space_references re-created', await tableExists(conn, schema, 'reservation_zone_space_references'));
    check('reapply4 reservation_zone_guid_registry re-created', await tableExists(conn, schema, 'reservation_zone_guid_registry'));
  } finally {
    await conn.end();
    await server.query(`DROP DATABASE \`${schema}\``);
    console.log(JSON.stringify({ event: 'rz2a1_self_test_end', disposableSchemaDropped: schema, failures }));
    await server.end();
  }
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
