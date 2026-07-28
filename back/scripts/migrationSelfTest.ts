/**
 * Disposable-schema self-test for the additive manager-role separation migration.
 *
 * Creates a brand-new, throwaway schema on the configured MySQL SERVER (never the
 * operational/demo database named by DB_NAME), builds a minimal but faithful role
 * catalogue (same UNIQUE key and RESTRICT foreign key as production), then runs
 * the real forward and rollback migration files through a runner that mirrors the
 * improved runSqlFile.ts (single connection, explicit ROLLBACK on error). It
 * verifies states A-F and always DROPs the disposable schema afterwards.
 *
 * Usage (safe): npx tsx scripts/migrationSelfTest.ts
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const MIG_DIR = path.resolve(import.meta.dirname, '../../database/migrations');
const FORWARD = path.join(MIG_DIR, '2026-07-27_manager_role_separation.sql');
const ROLLBACK = path.join(MIG_DIR, '2026-07-27_manager_role_separation_rollback.sql');

function splitStatements(sql: string): string[] {
  return sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    .split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}

// Mirrors the improved runSqlFile.ts: one connection, sequential statements,
// explicit ROLLBACK on any error (no-op when no transaction is active).
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
async function expectThrows(name: string, fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); check(name, false, 'expected an explicit failure but none occurred'); return false; }
  catch { console.log(`    PASS  ${name} (explicit failure raised)`); return true; }
}

async function resetCatalogue(conn: mysql.Connection) {
  await conn.query('DELETE FROM application_account_roles');
  await conn.query('DELETE FROM reservation_decisions');
  await conn.query('DELETE FROM application_roles');
  await conn.query('DELETE FROM application_accounts');
}
async function seedRole(conn: mysql.Connection, key: string, label: string): Promise<number> {
  const [r]: any = await conn.query('INSERT INTO application_roles (role_key, normalized_role_key, display_label) VALUES (?,?,?)', [key, key, label]);
  return Number(r.insertId);
}
async function seedAccount(conn: mysql.Connection, key: string): Promise<number> {
  const [r]: any = await conn.query('INSERT INTO application_accounts (account_key) VALUES (?)', [key]);
  return Number(r.insertId);
}
async function grant(conn: mysql.Connection, accountId: number, roleId: number) {
  await conn.query('INSERT INTO application_account_roles (application_account_id, application_role_id) VALUES (?,?)', [accountId, roleId]);
}
async function roleId(conn: mysql.Connection, key: string): Promise<number | null> {
  const [rows]: any = await conn.query('SELECT id FROM application_roles WHERE normalized_role_key=?', [key]);
  return rows.length ? Number(rows[0].id) : null;
}
async function roleCount(conn: mysql.Connection, key: string): Promise<number> {
  const [rows]: any = await conn.query('SELECT COUNT(*) AS c FROM application_roles WHERE normalized_role_key=?', [key]);
  return Number(rows[0].c);
}
async function grantRoleId(conn: mysql.Connection, accountId: number): Promise<number | null> {
  const [rows]: any = await conn.query('SELECT application_role_id FROM application_account_roles WHERE application_account_id=?', [accountId]);
  return rows.length ? Number(rows[0].application_role_id) : null;
}

async function main() {
  const operationalDb = process.env.DB_NAME;
  const schema = `oswadt_migtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  if (schema === operationalDb) throw new Error('refusing to reuse the operational database name');

  // env-derived config is string|undefined; cast as the repo's runner does.
  const baseConfig = {
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, multipleStatements: false,
  } as any;
  const server = await mysql.createConnection(baseConfig);
  console.log(JSON.stringify({ event: 'migration_self_test_start', disposableSchema: schema, operationalDatabase: operationalDb, note: 'operational database is never selected or modified' }));
  await server.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4`);
  const conn = await mysql.createConnection({ ...baseConfig, database: schema } as any);
  try {
    await conn.query('CREATE TABLE application_accounts (id BIGINT NOT NULL AUTO_INCREMENT, account_key VARCHAR(255) NOT NULL, PRIMARY KEY (id))');
    await conn.query('CREATE TABLE application_roles (id BIGINT NOT NULL AUTO_INCREMENT, role_key VARCHAR(100) NOT NULL, normalized_role_key VARCHAR(100) NOT NULL, display_label VARCHAR(255) NOT NULL, PRIMARY KEY (id), UNIQUE KEY uq_application_role_key (normalized_role_key))');
    await conn.query('CREATE TABLE application_account_roles (id BIGINT NOT NULL AUTO_INCREMENT, application_account_id BIGINT NOT NULL, application_role_id BIGINT NOT NULL, revoked_at DATETIME(3) NULL, PRIMARY KEY (id), UNIQUE KEY uq_application_account_role (application_account_id, application_role_id), CONSTRAINT fk_account_role_account FOREIGN KEY (application_account_id) REFERENCES application_accounts (id), CONSTRAINT fk_account_role_role FOREIGN KEY (application_role_id) REFERENCES application_roles (id))');
    await conn.query('CREATE TABLE reservation_decisions (id BIGINT NOT NULL AUTO_INCREMENT, manager_role_snapshot VARCHAR(100) NOT NULL, PRIMARY KEY (id))');

    // A. LEGACY STATE -> forward succeeds, id/grant preserved, both roles present.
    console.log('  [A] legacy state');
    await resetCatalogue(conn);
    const acc = await seedAccount(conn, 'manager-demo-001');
    const legacyId = await seedRole(conn, 'reservation_manager', 'Reservation manager');
    await grant(conn, acc, legacyId);
    await applyMigration(conn, FORWARD);
    check('A1 operational_manager keeps the legacy role id', await roleId(conn, 'operational_manager') === legacyId, `expected ${legacyId}`);
    check('A2 account grant still points to that same role id', await grantRoleId(conn, acc) === legacyId);
    check('A3 bim_manager exists', (await roleId(conn, 'bim_manager')) !== null);
    check('A4 reservation_manager no longer exists', (await roleId(conn, 'reservation_manager')) === null);

    // B. ALREADY MIGRATED -> forward is safely repeatable.
    console.log('  [B] already migrated state');
    await applyMigration(conn, FORWARD); // run again on A's result
    check('B1 exactly one operational_manager row', await roleCount(conn, 'operational_manager') === 1);
    check('B2 exactly one bim_manager row', await roleCount(conn, 'bim_manager') === 1);
    check('B3 operational_manager id unchanged', await roleId(conn, 'operational_manager') === legacyId);
    check('B4 grant still intact', await grantRoleId(conn, acc) === legacyId);

    // C. INVALID DUAL STATE -> forward fails explicitly, no partial change.
    console.log('  [C] invalid dual state');
    await resetCatalogue(conn);
    const dualLegacy = await seedRole(conn, 'reservation_manager', 'Reservation manager');
    const dualCanonical = await seedRole(conn, 'operational_manager', 'Operational Manager');
    await expectThrows('C1 forward migration fails on dual state', () => applyMigration(conn, FORWARD));
    check('C2 no bim_manager was inserted (no partial change)', (await roleId(conn, 'bim_manager')) === null);
    check('C3 reservation_manager row unchanged', await roleId(conn, 'reservation_manager') === dualLegacy);
    check('C4 operational_manager row unchanged', await roleId(conn, 'operational_manager') === dualCanonical);

    // D. SAFE ROLLBACK -> restores reservation_manager, preserves id/grant, removes bim_manager.
    console.log('  [D] safe rollback');
    await resetCatalogue(conn);
    const accD = await seedAccount(conn, 'manager-demo-001');
    const opId = await seedRole(conn, 'operational_manager', 'Operational Manager');
    const bimId = await seedRole(conn, 'bim_manager', 'BIM Manager');
    await grant(conn, accD, opId); // only an operational grant, no bim grant
    await applyMigration(conn, ROLLBACK);
    check('D1 reservation_manager restored with the same id', await roleId(conn, 'reservation_manager') === opId, `expected ${opId}`);
    check('D2 operational grant preserved (now points to reservation_manager id)', await grantRoleId(conn, accD) === opId);
    check('D3 bim_manager removed', (await roleId(conn, 'bim_manager')) === null, `bim id was ${bimId}`);

    // E. UNSAFE ROLLBACK -> fails explicitly, leaves everything untouched.
    console.log('  [E] unsafe rollback (bim_manager grant present)');
    await resetCatalogue(conn);
    const accE = await seedAccount(conn, 'bim-user');
    const opIdE = await seedRole(conn, 'operational_manager', 'Operational Manager');
    const bimIdE = await seedRole(conn, 'bim_manager', 'BIM Manager');
    await grant(conn, accE, bimIdE);
    await expectThrows('E1 rollback fails while a bim_manager grant exists', () => applyMigration(conn, ROLLBACK));
    check('E2 operational_manager remains operational_manager', await roleId(conn, 'operational_manager') === opIdE);
    check('E3 bim_manager still exists', await roleId(conn, 'bim_manager') === bimIdE);
    check('E4 bim_manager grant untouched', await grantRoleId(conn, accE) === bimIdE);

    // F. HISTORICAL SNAPSHOT -> never rewritten by forward or rollback.
    console.log('  [F] historical decision snapshot');
    await resetCatalogue(conn);
    const accF = await seedAccount(conn, 'manager-demo-001');
    const legacyIdF = await seedRole(conn, 'reservation_manager', 'Reservation manager');
    await grant(conn, accF, legacyIdF);
    await conn.query("INSERT INTO reservation_decisions (manager_role_snapshot) VALUES ('reservation_manager')");
    await applyMigration(conn, FORWARD);
    const [afterFwd]: any = await conn.query('SELECT manager_role_snapshot FROM reservation_decisions');
    check('F1 snapshot unchanged after forward', afterFwd[0].manager_role_snapshot === 'reservation_manager');
    await applyMigration(conn, ROLLBACK); // no bim grants here, safe
    const [afterRb]: any = await conn.query('SELECT manager_role_snapshot FROM reservation_decisions');
    check('F2 snapshot unchanged after rollback', afterRb[0].manager_role_snapshot === 'reservation_manager');
  } finally {
    await conn.end();
    await server.query(`DROP DATABASE \`${schema}\``);
    console.log(JSON.stringify({ event: 'migration_self_test_end', disposableSchemaDropped: schema, failures }));
    await server.end();
  }
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
