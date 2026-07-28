/**
 * CLI entrypoint for the Stage 0A IfcSpace-GlobalId schema migration.
 *
 * Runs the migration MECHANISM (scripts/migrations/spaceGlobalId.ts) against the
 * database named by .env DB_NAME, on a single connection, behind explicit
 * confirmation flags and a migration-specific advisory lock.
 *
 *   Forward:
 *     cd back && npx tsx scripts/runSpaceGlobalIdMigration.ts \
 *       --confirm-database <name> --maintenance-confirmed
 *   Rollback:
 *     cd back && npx tsx scripts/runSpaceGlobalIdMigration.ts --rollback \
 *       --confirm-rollback --confirm-database <name> --maintenance-confirmed
 *
 * MAINTENANCE WINDOW REQUIRED. Stage 0A keeps ifc_global_id NULLable, so an
 * application write (model activation / space or binding persistence) AFTER the
 * final verification could introduce a fresh NULL row. All backend processes
 * capable of such writes MUST be stopped before running this. The advisory lock
 * only prevents two migration executors from running at once — it does NOT block
 * ordinary application writes.
 *
 * Stage 0A is ADDITIVE and does not change any runtime identity behaviour. Verify
 * on a disposable schema (scripts/spaceGlobalIdMigrationSelfTest.ts) and take a
 * fresh backup before applying to the active development/demo database. The
 * archived post-presentation baseline/tag must remain untouched.
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import { applyForward, applyRollback } from "./migrations/spaceGlobalId.ts";

export const ADVISORY_LOCK_NAME = "oswadt:space_globalid_migration";
const SYSTEM_SCHEMAS = new Set(["mysql", "information_schema", "performance_schema", "sys"]);

/**
 * Case-insensitive check for MySQL system schemas. Case-folding applies ONLY to
 * identifying forbidden system names; it never relaxes the exact target
 * confirmation (--confirm-database === DB_NAME === SELECT DATABASE()).
 */
export function isSystemSchema(name: string): boolean {
  return SYSTEM_SCHEMAS.has(String(name ?? "").trim().toLowerCase());
}

export interface CliConfig {
  direction: "forward" | "rollback";
  confirmDatabase: string;
  maintenanceConfirmed: boolean;
}

/**
 * Strict argument parser. Unknown tokens FAIL rather than being ignored. Returns a
 * validated config or throws. Pure (no I/O) so it is directly unit-testable.
 */
export function parseCliArgs(argv: string[]): CliConfig {
  let rollback = false;
  let confirmRollback = false;
  let maintenanceConfirmed = false;
  let confirmDatabase: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--rollback": rollback = true; break;
      case "--confirm-rollback": confirmRollback = true; break;
      case "--maintenance-confirmed": maintenanceConfirmed = true; break;
      case "--confirm-database": {
        const value = argv[++i];
        if (!value || value.startsWith("--")) throw new Error("--confirm-database requires a database name");
        confirmDatabase = value;
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!confirmDatabase) throw new Error("--confirm-database <name> is required");
  if (!maintenanceConfirmed) throw new Error("--maintenance-confirmed is required (stop all backend processes first)");

  if (rollback) {
    if (!confirmRollback) throw new Error("rollback requires --confirm-rollback");
    return { direction: "rollback", confirmDatabase, maintenanceConfirmed };
  }
  if (confirmRollback) throw new Error("--confirm-rollback is only valid together with --rollback");
  return { direction: "forward", confirmDatabase, maintenanceConfirmed };
}

/**
 * Verify the target: DB_NAME set, the --confirm-database argument, DB_NAME and the
 * live SELECT DATABASE() must all be equal, and must not be a system schema.
 */
export async function assertConfirmedTarget(conn: mysql.Connection, config: CliConfig): Promise<string> {
  const envName = process.env.DB_NAME;
  if (!envName) throw new Error("DB_NAME is not set");
  const [r]: any = await conn.query("SELECT DATABASE() AS db");
  const liveDb: string | null = r[0]?.db ?? null;
  if (config.confirmDatabase !== envName) throw new Error(`--confirm-database (${config.confirmDatabase}) does not match DB_NAME (${envName})`);
  if (liveDb !== envName) throw new Error(`connected database (${liveDb}) does not match DB_NAME (${envName})`);
  if (isSystemSchema(String(liveDb))) throw new Error(`refusing to migrate a system schema: ${liveDb}`);
  return String(liveDb);
}

async function main() {
  const config = parseCliArgs(process.argv.slice(2));
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: false,
  } as any);

  let lockAcquired = false;
  try {
    const db = await assertConfirmedTarget(conn, config);
    // never log the password
    console.log(JSON.stringify({ event: "space_globalid_migration_start", host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: db, direction: config.direction }));

    const [lockRows]: any = await conn.query("SELECT GET_LOCK(?, 0) AS ok", [ADVISORY_LOCK_NAME]);
    if (Number(lockRows[0]?.ok) !== 1) throw new Error(`could not acquire migration advisory lock '${ADVISORY_LOCK_NAME}' — another executor may be running`);
    lockAcquired = true;

    const result = config.direction === "rollback" ? await applyRollback(conn) : await applyForward(conn);
    console.log(JSON.stringify({ event: "space_globalid_migration_done", direction: config.direction, result }));
  } finally {
    if (lockAcquired) { try { await conn.query("SELECT RELEASE_LOCK(?)", [ADVISORY_LOCK_NAME]); } catch { /* connection may be gone */ } }
    await conn.end();
  }
}

// Only run when invoked directly (not when imported by the arg-parsing tests).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("runSpaceGlobalIdMigration.ts")) {
  main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
}
