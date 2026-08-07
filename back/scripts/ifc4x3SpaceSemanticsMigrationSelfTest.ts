/**
 * Disposable-schema self-test for the IFC4x3 space-semantics migration (ADR-0052):
 *   database/migrations/2026-08-04_ifc4x3_space_semantics.sql (+ rollback).
 *
 * Creates a brand-new throwaway schema on the configured MySQL SERVER (NEVER the
 * operational/demo database named by DB_NAME), builds a minimal but faithful subset of
 * the real schema (spaces + space_bindings with the pre-migration shape, assets with the
 * legacy asset_type ENUM('space','equipment','tool'), and every FK-dependent table the
 * cleanup touches), seeds legacy space assets alongside real equipment, runs the REAL
 * forward + rollback files, and verifies states A–C. The disposable schema is ALWAYS
 * dropped afterwards; digital_twin is never selected or modified.
 *
 * Usage (safe): npx tsx scripts/ifc4x3SpaceSemanticsMigrationSelfTest.ts
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const MIG_DIR = path.resolve(import.meta.dirname, '../../database/migrations');
const FORWARD = path.join(MIG_DIR, '2026-08-04_ifc4x3_space_semantics.sql');
const ROLLBACK = path.join(MIG_DIR, '2026-08-04_ifc4x3_space_semantics_rollback.sql');

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
async function columnExists(conn: mysql.Connection, schema: string, table: string, column: string): Promise<boolean> {
  return Number(await scalar(conn,
    `SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?`,
    [schema, table, column])) > 0;
}
async function indexExists(conn: mysql.Connection, schema: string, table: string, index: string): Promise<boolean> {
  return Number(await scalar(conn,
    `SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=? AND table_name=? AND index_name=?`,
    [schema, table, index])) > 0;
}
async function fkExists(conn: mysql.Connection, schema: string, table: string, constraint: string): Promise<boolean> {
  return Number(await scalar(conn,
    `SELECT COUNT(*) FROM information_schema.table_constraints
      WHERE table_schema=? AND table_name=? AND constraint_name=? AND constraint_type='FOREIGN KEY'`,
    [schema, table, constraint])) > 0;
}

async function buildSchema(conn: mysql.Connection) {
  await conn.query(`CREATE TABLE linked_models (id INT PRIMARY KEY AUTO_INCREMENT)`);
  await conn.query(`CREATE TABLE models (id INT PRIMARY KEY AUTO_INCREMENT, linked_parent_id INT,
    CONSTRAINT fk_m_lm FOREIGN KEY (linked_parent_id) REFERENCES linked_models(id))`);
  await conn.query(`CREATE TABLE model_versions (id INT PRIMARY KEY AUTO_INCREMENT, model_id INT,
    CONSTRAINT fk_mv_m FOREIGN KEY (model_id) REFERENCES models(id))`);
  await conn.query(`CREATE TABLE entities (id INT PRIMARY KEY AUTO_INCREMENT, model_version_id INT,
    CONSTRAINT fk_e_mv FOREIGN KEY (model_version_id) REFERENCES model_versions(id))`);
  // spaces in the PRE-migration shape: has \`name\`, canonical GlobalId column + indexes.
  await conn.query(`CREATE TABLE spaces (
    id INT PRIMARY KEY AUTO_INCREMENT, space_uuid CHAR(36) NOT NULL,
    ifc_global_id CHAR(22) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    inventory_code VARCHAR(200) NOT NULL, inventory_code_normalized VARCHAR(200) NOT NULL,
    linked_model_id INT NOT NULL, name VARCHAR(255) DEFAULT NULL,
    status ENUM('active','absent','retired') NOT NULL DEFAULT 'active',
    UNIQUE KEY uq_spaces_uuid (space_uuid),
    UNIQUE KEY uq_spaces_linked_model_ifc_global_id (linked_model_id, ifc_global_id),
    UNIQUE KEY uq_spaces_scope_code (linked_model_id, inventory_code_normalized),
    CONSTRAINT fk_s_lm FOREIGN KEY (linked_model_id) REFERENCES linked_models(id))`);
  await conn.query(`CREATE TABLE space_bindings (
    id INT PRIMARY KEY AUTO_INCREMENT, space_id INT NOT NULL, model_version_id INT NOT NULL,
    entity_id INT NOT NULL, ifc_guid VARCHAR(100) NOT NULL,
    inventory_code_snapshot VARCHAR(200) NOT NULL, name_snapshot VARCHAR(255) DEFAULT NULL,
    long_name_snapshot VARCHAR(255) DEFAULT NULL, binding_status VARCHAR(20) NOT NULL DEFAULT 'active',
    UNIQUE KEY uq_binding_entity (entity_id), UNIQUE KEY uq_binding_space_version (space_id, model_version_id),
    CONSTRAINT fk_sb_s FOREIGN KEY (space_id) REFERENCES spaces(id),
    CONSTRAINT fk_sb_mv FOREIGN KEY (model_version_id) REFERENCES model_versions(id),
    CONSTRAINT fk_sb_e FOREIGN KEY (entity_id) REFERENCES entities(id))`);
  // Real constraint/index names (2026-07-17_asset_identity.sql) so the forward migration's
  // DROP FOREIGN KEY fk_assets_space / DROP INDEX uq_assets_space exercise the actual names.
  await conn.query(`CREATE TABLE assets (
    id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(255) NOT NULL,
    asset_type ENUM('space','equipment','tool') NOT NULL, model_version_id INT NULL,
    space_id INT NULL, linked_model_id INT NULL,
    UNIQUE KEY uq_assets_space (space_id),
    CONSTRAINT fk_assets_space FOREIGN KEY (space_id) REFERENCES spaces(id),
    CONSTRAINT fk_a_mv FOREIGN KEY (model_version_id) REFERENCES model_versions(id))`);
  // asset_bindings carries the version-specific location (space_id); many bindings may share
  // one space (no uniqueness on space_id) — only entity and (asset,version) are unique.
  await conn.query(`CREATE TABLE asset_bindings (id INT PRIMARY KEY AUTO_INCREMENT, asset_id INT NOT NULL,
    model_version_id INT NOT NULL, model_entity_id INT NOT NULL, space_id INT NULL, ifc_guid VARCHAR(100) NOT NULL,
    UNIQUE KEY uq_ab_entity (model_entity_id),
    UNIQUE KEY uq_ab_asset_version (asset_id, model_version_id),
    CONSTRAINT fk_ab_a FOREIGN KEY (asset_id) REFERENCES assets(id),
    CONSTRAINT fk_ab_space FOREIGN KEY (space_id) REFERENCES spaces(id),
    CONSTRAINT fk_ab_mv FOREIGN KEY (model_version_id) REFERENCES model_versions(id),
    CONSTRAINT fk_ab_e FOREIGN KEY (model_entity_id) REFERENCES entities(id))`);
  await conn.query(`CREATE TABLE asset_reconciliation_cases (id INT PRIMARY KEY AUTO_INCREMENT,
    model_version_id INT NOT NULL, model_entity_id INT NOT NULL, ifc_guid VARCHAR(100) NOT NULL,
    resolved_asset_id INT NULL, UNIQUE KEY uq_arc_entity (model_entity_id),
    CONSTRAINT fk_arc_mv FOREIGN KEY (model_version_id) REFERENCES model_versions(id),
    CONSTRAINT fk_arc_e FOREIGN KEY (model_entity_id) REFERENCES entities(id),
    CONSTRAINT fk_arc_a FOREIGN KEY (resolved_asset_id) REFERENCES assets(id))`);
  await conn.query(`CREATE TABLE asset_location_assignments (id INT PRIMARY KEY AUTO_INCREMENT,
    assignment_uuid CHAR(36) NOT NULL, semantic_assertion_uri VARCHAR(500) NOT NULL,
    asset_id INT NOT NULL, space_id INT NOT NULL, source VARCHAR(30) NOT NULL, valid_from DATETIME NOT NULL,
    UNIQUE KEY uq_ala_uuid (assignment_uuid),
    CONSTRAINT fk_ala_a FOREIGN KEY (asset_id) REFERENCES assets(id),
    CONSTRAINT fk_ala_s FOREIGN KEY (space_id) REFERENCES spaces(id))`);
  await conn.query(`CREATE TABLE legacy_asset_mapping (legacy_asset_id INT PRIMARY KEY,
    persistent_asset_id INT NULL, mapping_status ENUM('mapped','ambiguous','unrecoverable') NOT NULL,
    CONSTRAINT fk_lam_a FOREIGN KEY (persistent_asset_id) REFERENCES assets(id))`);
  await conn.query(`CREATE TABLE semantic_evidence_runs (id INT PRIMARY KEY AUTO_INCREMENT, asset_id INT NOT NULL,
    CONSTRAINT fk_ser_a FOREIGN KEY (asset_id) REFERENCES assets(id))`);
  await conn.query(`CREATE TABLE semantic_evidence_findings (id INT PRIMARY KEY AUTO_INCREMENT, evidence_run_id INT NOT NULL,
    CONSTRAINT fk_sef_r FOREIGN KEY (evidence_run_id) REFERENCES semantic_evidence_runs(id))`);
  await conn.query(`CREATE TABLE reservation_management_scopes (id INT PRIMARY KEY AUTO_INCREMENT, asset_id INT NOT NULL,
    CONSTRAINT fk_rms_a FOREIGN KEY (asset_id) REFERENCES assets(id))`);
  await conn.query(`CREATE TABLE res_reservations (id INT PRIMARY KEY AUTO_INCREMENT, asset_id INT NOT NULL,
    actor_id VARCHAR(100) NOT NULL, start_time DATETIME NOT NULL, end_time DATETIME NOT NULL,
    CONSTRAINT fk_rr_a FOREIGN KEY (asset_id) REFERENCES assets(id))`);
  await conn.query(`CREATE TABLE reservation_semantic_evidence_links (id INT PRIMARY KEY AUTO_INCREMENT, reservation_id INT NOT NULL,
    CONSTRAINT fk_rsel_r FOREIGN KEY (reservation_id) REFERENCES res_reservations(id))`);
  await conn.query(`CREATE TABLE reservation_decisions (id INT PRIMARY KEY AUTO_INCREMENT, reservation_id INT NULL,
    CONSTRAINT fk_rd_r FOREIGN KEY (reservation_id) REFERENCES res_reservations(id))`);
  await conn.query(`CREATE TABLE reservation_manager_evidence_reviews (id INT PRIMARY KEY AUTO_INCREMENT, reservation_id INT NOT NULL,
    CONSTRAINT fk_rmer_r FOREIGN KEY (reservation_id) REFERENCES res_reservations(id))`);
}

async function seed(conn: mysql.Connection) {
  await conn.query(`INSERT INTO linked_models (id) VALUES (1)`);
  await conn.query(`INSERT INTO models (id, linked_parent_id) VALUES (1, 1)`);
  await conn.query(`INSERT INTO model_versions (id, model_id) VALUES (1, 1)`);
  await conn.query(`INSERT INTO entities (id, model_version_id) VALUES (1,1),(2,1),(3,1),(4,1),(5,1)`);
  // 3 spaces. Under the OLD semantics, inventory_code held the Reference and \`name\` held the
  // raw IFC Name — we seed exactly that so the migration's TRUTHFULNESS can be asserted.
  await conn.query(`INSERT INTO spaces (id, space_uuid, ifc_global_id, inventory_code, inventory_code_normalized, linked_model_id, name) VALUES
    (1,'u1','0AAAAAAAAAAAAAAAAAAAA1','R-101','R-101',1,'Sala 101 (old IFC Name)'),
    (2,'u2','0AAAAAAAAAAAAAAAAAAAA2','R-102','R-102',1,'Sala 102 (old IFC Name)'),
    (3,'u3','0AAAAAAAAAAAAAAAAAAAA3','R-103','R-103',1,'Sala 103 (old IFC Name)')`);
  await conn.query(`INSERT INTO space_bindings (space_id, model_version_id, entity_id, ifc_guid, inventory_code_snapshot, name_snapshot, long_name_snapshot) VALUES
    (1,1,1,'0AAAAAAAAAAAAAAAAAAAA1','R-101','Sala 101','Long 101'),
    (2,1,2,'0AAAAAAAAAAAAAAAAAAAA2','R-102','Sala 102','Long 102')`);
  // Assets: two LEGACY space assets (asset_type='space', space_id 1,2 — the removed 1:1 model)
  // plus TWO real EQUIPMENT assets. Real equipment carries assets.space_id = NULL: modelled
  // location is version-specific in asset_bindings.space_id, NOT on the persistent asset row.
  await conn.query(`INSERT INTO assets (id, name, asset_type, model_version_id, space_id, linked_model_id) VALUES
    (1,'Space 101','space',1,1,1),
    (2,'Space 102','space',1,2,1),
    (3,'Boiler','equipment',1,NULL,1),
    (4,'Pump','equipment',1,NULL,1)`);
  // Bindings carry the location. Space assets (1,2) have NULL space_id; the two equipment
  // assets (3 Boiler, 4 Pump) are BOTH bound to the SAME space 3 — proving many equipment can
  // share one space (no uniqueness on asset_bindings.space_id).
  await conn.query(`INSERT INTO asset_bindings (asset_id, model_version_id, model_entity_id, space_id, ifc_guid) VALUES
    (1,1,1,NULL,'g1'),(2,1,2,NULL,'g2'),(3,1,3,3,'g3'),(4,1,5,3,'g5')`);
  await conn.query(`INSERT INTO asset_reconciliation_cases (model_version_id, model_entity_id, ifc_guid, resolved_asset_id) VALUES
    (1,4,'gx',1)`);
  await conn.query(`INSERT INTO asset_location_assignments (assignment_uuid, semantic_assertion_uri, asset_id, space_id, source, valid_from) VALUES
    ('a1','uri1',1,1,'ifc',NOW()),('a3','uri3',3,3,'ifc',NOW())`);
  await conn.query(`INSERT INTO legacy_asset_mapping (legacy_asset_id, persistent_asset_id, mapping_status) VALUES (1,1,'mapped')`);
  await conn.query(`INSERT INTO semantic_evidence_runs (id, asset_id) VALUES (1,1),(2,3)`);
  await conn.query(`INSERT INTO semantic_evidence_findings (evidence_run_id) VALUES (1),(2)`);
  await conn.query(`INSERT INTO reservation_management_scopes (asset_id) VALUES (1),(3)`);
  // Reservations: one for a legacy space asset (removed), one for the equipment asset (kept).
  await conn.query(`INSERT INTO res_reservations (id, asset_id, actor_id, start_time, end_time) VALUES
    (1,1,'student-1',NOW(),NOW()),(2,3,'student-2',NOW(),NOW())`);
  await conn.query(`INSERT INTO reservation_semantic_evidence_links (reservation_id) VALUES (1),(2)`);
  await conn.query(`INSERT INTO reservation_decisions (reservation_id) VALUES (1),(2)`);
  await conn.query(`INSERT INTO reservation_manager_evidence_reviews (reservation_id) VALUES (1),(2)`);
}

async function main() {
  const operationalDb = process.env.DB_NAME;
  const schema = `oswadt_ifc4x3_migtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  if (schema === operationalDb) throw new Error('refusing to reuse the operational database name');
  const baseConfig = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, multipleStatements: false } as any;
  const server = await mysql.createConnection(baseConfig);
  console.log(JSON.stringify({ event: 'migration_self_test_start', disposableSchema: schema, operationalDatabase: operationalDb, note: 'operational database is never selected or modified' }));
  await server.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
  const conn = await mysql.createConnection({ ...baseConfig, database: schema } as any);
  try {
    await buildSchema(conn);
    await seed(conn);

    // Capture the pre-migration space \`name\` values to prove the rename PRESERVES data.
    const nameBefore = await scalar(conn, `SELECT name FROM spaces WHERE id=1`);

    await applyMigration(conn, FORWARD);

    // ---- A. COLUMN RENAME ----
    console.log('  [A] column rename + index integrity');
    check('A1 spaces.name is gone', !(await columnExists(conn, schema, 'spaces', 'name')));
    check('A2 spaces.long_name exists', await columnExists(conn, schema, 'spaces', 'long_name'));
    check('A3 spaces.name data preserved as long_name', await scalar(conn, `SELECT long_name FROM spaces WHERE id=1`) === nameBefore);
    check('A4 inventory_code still present', await columnExists(conn, schema, 'spaces', 'inventory_code'));
    check('A5 canonical GlobalId index remains exact', await indexExists(conn, schema, 'spaces', 'uq_spaces_linked_model_ifc_global_id'));
    check('A6 scope inventory-code uniqueness remains', await indexExists(conn, schema, 'spaces', 'uq_spaces_scope_code'));
    check('A7 space_bindings.name_snapshot dropped', !(await columnExists(conn, schema, 'space_bindings', 'name_snapshot')));
    check('A8 space_bindings.long_name_snapshot kept', await columnExists(conn, schema, 'space_bindings', 'long_name_snapshot'));

    // ---- B. LEGACY SPACE-ASSET CLEANUP ----
    console.log('  [B] legacy space-asset cleanup (equipment preserved)');
    check('B1 all 3 spaces remain', Number(await scalar(conn, `SELECT COUNT(*) FROM spaces`)) === 3);
    check('B2 all space bindings remain', Number(await scalar(conn, `SELECT COUNT(*) FROM space_bindings`)) === 2);
    check('B3 legacy space assets removed', Number(await scalar(conn, `SELECT COUNT(*) FROM assets WHERE id IN (1,2)`)) === 0);
    check('B4 both equipment assets preserved', Number(await scalar(conn, `SELECT COUNT(*) FROM assets WHERE id IN (3,4)`)) === 2);
    // B5: modelled equipment location lives on the BINDING, not on assets.space_id.
    check('B5 equipment binding retains its space (asset 3 → space 3)',
      Number(await scalar(conn, `SELECT space_id FROM asset_bindings WHERE asset_id=3`)) === 3);
    check('B6 space-asset bindings removed', Number(await scalar(conn, `SELECT COUNT(*) FROM asset_bindings WHERE asset_id IN (1,2)`)) === 0);
    check('B7 equipment bindings preserved', Number(await scalar(conn, `SELECT COUNT(*) FROM asset_bindings WHERE asset_id IN (3,4)`)) === 2);
    check('B8 space-asset reservation removed', Number(await scalar(conn, `SELECT COUNT(*) FROM res_reservations WHERE id=1`)) === 0);
    check('B9 equipment reservation preserved', Number(await scalar(conn, `SELECT COUNT(*) FROM res_reservations WHERE id=2`)) === 1);
    check('B10 space-asset location rows removed', Number(await scalar(conn, `SELECT COUNT(*) FROM asset_location_assignments WHERE asset_id IN (1,2)`)) === 0);
    check('B11 equipment location row preserved', Number(await scalar(conn, `SELECT COUNT(*) FROM asset_location_assignments WHERE asset_id=3`)) === 1);
    check('B12 space-asset reconciliation removed', Number(await scalar(conn, `SELECT COUNT(*) FROM asset_reconciliation_cases WHERE resolved_asset_id IN (1,2)`)) === 0);
    check('B13 space-asset legacy mapping removed', Number(await scalar(conn, `SELECT COUNT(*) FROM legacy_asset_mapping WHERE persistent_asset_id IN (1,2)`)) === 0);
    check('B14 space-asset evidence run removed', Number(await scalar(conn, `SELECT COUNT(*) FROM semantic_evidence_runs WHERE asset_id IN (1,2)`)) === 0);
    check('B15 equipment evidence run preserved', Number(await scalar(conn, `SELECT COUNT(*) FROM semantic_evidence_runs WHERE asset_id=3`)) === 1);
    check('B16 asset_type ENUM contracted (no space member)', !/space/i.test(String(await scalar(conn,
      `SELECT COLUMN_TYPE FROM information_schema.columns WHERE table_schema=? AND table_name='assets' AND column_name='asset_type'`, [schema] as any))));
    // The post-migration schema must REFUSE any attempt to (re)create a space asset — the
    // runtime never inserts asset_type='space', and the ENUM enforces this at the DB level.
    // (No space_id column here: forward step D dropped it.)
    let spaceInsertRejected = false;
    try { await conn.query(`INSERT INTO assets (name, asset_type, linked_model_id) VALUES ('x','space',1)`); }
    catch { spaceInsertRejected = true; }
    check('B17 post-migration insert of asset_type=space is rejected', spaceInsertRejected);

    // ---- D. LEGACY assets.space_id REMOVAL ----
    console.log('  [D] legacy assets.space_id column/index/FK removed; binding location intact');
    check('D1 assets.space_id column removed', !(await columnExists(conn, schema, 'assets', 'space_id')));
    check('D2 uq_assets_space index removed', !(await indexExists(conn, schema, 'assets', 'uq_assets_space')));
    check('D3 fk_assets_space foreign key removed', !(await fkExists(conn, schema, 'assets', 'fk_assets_space')));
    check('D4 asset_bindings.space_id still exists', await columnExists(conn, schema, 'asset_bindings', 'space_id'));
    check('D5 asset_location_assignments.space_id still exists', await columnExists(conn, schema, 'asset_location_assignments', 'space_id'));
    check('D6 two distinct equipment assets bind to the SAME space 3',
      Number(await scalar(conn, `SELECT COUNT(DISTINCT asset_id) FROM asset_bindings WHERE space_id=3`)) === 2);
    check('D7 no orphan asset_bindings (every asset_id resolves)',
      Number(await scalar(conn, `SELECT COUNT(*) FROM asset_bindings ab LEFT JOIN assets a ON a.id=ab.asset_id WHERE a.id IS NULL`)) === 0);
    check('D8 no orphan binding space_id (every non-null space resolves)',
      Number(await scalar(conn, `SELECT COUNT(*) FROM asset_bindings ab LEFT JOIN spaces s ON s.id=ab.space_id WHERE ab.space_id IS NOT NULL AND s.id IS NULL`)) === 0);

    // ---- C. NO SEMANTIC BACKFILL CLAIM ----
    console.log('  [C] no semantic backfill claim');
    // The migration must NOT infer IfcSpace.Name from the old Reference-derived inventory_code:
    // inventory_code is untouched (still the old Reference value) and long_name still holds the
    // OLD raw IFC Name — nothing was reprojected. Re-ingestion remains required.
    check('C1 inventory_code NOT reprojected (still old value)', await scalar(conn, `SELECT inventory_code FROM spaces WHERE id=1`) === 'R-101');
    check('C2 long_name is the preserved OLD name, not derived from Reference', await scalar(conn, `SELECT long_name FROM spaces WHERE id=1`) === nameBefore);

    // ---- rollback: structural revert (space assets are NOT restored) ----
    console.log('  [rollback] structural revert');
    await applyMigration(conn, ROLLBACK);
    check('R1 spaces.long_name reverted to name', await columnExists(conn, schema, 'spaces', 'name') && !(await columnExists(conn, schema, 'spaces', 'long_name')));
    check('R2 space_bindings.name_snapshot re-added', await columnExists(conn, schema, 'space_bindings', 'name_snapshot'));
    check('R3 asset_type ENUM re-widened to include space', /space/i.test(String(await scalar(conn,
      `SELECT COLUMN_TYPE FROM information_schema.columns WHERE table_schema=? AND table_name='assets' AND column_name='asset_type'`, [schema] as any))));
    check('R4 deleted space assets are NOT restored (synthetic data, re-ingestion required)', Number(await scalar(conn, `SELECT COUNT(*) FROM assets WHERE id IN (1,2)`)) === 0);
    check('R5 assets.space_id restored as a nullable column', await columnExists(conn, schema, 'assets', 'space_id')
      && String(await scalar(conn, `SELECT IS_NULLABLE FROM information_schema.columns WHERE table_schema=? AND table_name='assets' AND column_name='space_id'`, [schema] as any)) === 'YES');
    check('R6 uq_assets_space restored', await indexExists(conn, schema, 'assets', 'uq_assets_space'));
    check('R7 fk_assets_space restored', await fkExists(conn, schema, 'assets', 'fk_assets_space'));
    check('R8 restored assets.space_id is empty/NULL (old 1:1 values NOT reconstructed)',
      Number(await scalar(conn, `SELECT COUNT(*) FROM assets WHERE space_id IS NOT NULL`)) === 0);
  } finally {
    await conn.end();
    await server.query(`DROP DATABASE \`${schema}\``);
    console.log(JSON.stringify({ event: 'migration_self_test_end', disposableSchemaDropped: schema, failures }));
    await server.end();
  }
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
