/**
 * Disposable-schema self-test for the Stage 0A IfcSpace-GlobalId migration.
 *
 * Creates a brand-new throwaway schema on the configured MySQL SERVER (never the
 * operational/demo database named by DB_NAME), builds a minimal but faithful
 * spaces / linked_models / models / model_versions / space_bindings structure
 * (same Reference-based uniqueness and the relevant foreign keys as production),
 * then runs the REAL migration mechanism (scripts/migrations/spaceGlobalId.ts)
 * through cases A-T.
 *
 * Cleanup is genuinely robust AND fatal: every cleanup step (close disposable
 * connection, drop disposable schema, close server connection) is attempted
 * independently; the primary error is preserved; and a primary OR any cleanup
 * error (including a schema that could not be dropped) always causes a non-zero
 * exit — an apparently successful run can never leave a disposable schema behind.
 *
 * Usage (safe): cd back && npx tsx scripts/spaceGlobalIdMigrationSelfTest.ts
 */
import "dotenv/config";
import mysql from "mysql2/promise";
import {
  applyForward, applyRollback, inspectColumn, inspectIndex, inspectCheck, inspectLegacyScopeIndex,
  columnExists, indexExists, checkConstraintExists,
  GLOBAL_ID_COLUMN, UNIQUE_INDEX, LEGACY_SCOPE_INDEX, CHECK_CONSTRAINT, SPACES_TABLE,
} from "./migrations/spaceGlobalId.ts";
import { classifyOutcome } from "./migrations/selfTestOutcome.ts";
import { parseCliArgs, assertConfirmedTarget, isSystemSchema } from "./runSpaceGlobalIdMigration.ts";

let failures = 0;
let passes = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) { passes += 1; console.log(`    PASS  ${name}`); }
  else { failures += 1; console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
async function expectThrows(name: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); failures += 1; console.log(`    FAIL  ${name} — expected an explicit failure but none occurred`); }
  catch { passes += 1; console.log(`    PASS  ${name} (explicit failure raised)`); }
}

const EXACT_COLUMN_DDL = `ALTER TABLE ${SPACES_TABLE} ADD COLUMN ${GLOBAL_ID_COLUMN} CHAR(22) CHARACTER SET ascii COLLATE ascii_bin NULL`;

async function seedEntity(conn: mysql.Connection): Promise<number> {
  const [r]: any = await conn.query("INSERT INTO entities () VALUES ()");
  return Number(r.insertId);
}
async function seedLinkedModel(conn: mysql.Connection, name: string): Promise<number> {
  const [r]: any = await conn.query("INSERT INTO linked_models (name) VALUES (?)", [name]);
  return Number(r.insertId);
}
async function seedModel(conn: mysql.Connection, linkedParentId: number | null): Promise<number> {
  const [r]: any = await conn.query("INSERT INTO models (model_uuid, linked_parent_id) VALUES (?, ?)", [crypto.randomUUID(), linkedParentId]);
  return Number(r.insertId);
}
async function seedVersion(conn: mysql.Connection, modelId: number, versionNumber: number): Promise<number> {
  const [r]: any = await conn.query("INSERT INTO model_versions (version_uuid, model_id, version_number) VALUES (?, ?, ?)", [crypto.randomUUID(), modelId, versionNumber]);
  return Number(r.insertId);
}
async function seedSpace(conn: mysql.Connection, linkedModelId: number, code: string, name: string): Promise<{ id: number; uuid: string }> {
  const uuid = crypto.randomUUID();
  const [r]: any = await conn.query(
    "INSERT INTO spaces (space_uuid, inventory_code, inventory_code_normalized, linked_model_id, name) VALUES (?, ?, ?, ?, ?)",
    [uuid, code, code, linkedModelId, name]);
  return { id: Number(r.insertId), uuid };
}
async function seedBinding(conn: mysql.Connection, spaceId: number, versionId: number, guid: string, refSnap: string): Promise<void> {
  const entityId = await seedEntity(conn);
  await conn.query(
    "INSERT INTO space_bindings (space_id, model_version_id, entity_id, ifc_guid, inventory_code_snapshot) VALUES (?, ?, ?, ?, ?)",
    [spaceId, versionId, entityId, guid, refSnap]);
}
async function spaceRow(conn: mysql.Connection, id: number): Promise<any> {
  const gidExpr = (await columnExists(conn)) ? GLOBAL_ID_COLUMN : "NULL";
  const [rows]: any = await conn.query(`SELECT id, space_uuid, inventory_code, ${gidExpr} AS gid FROM ${SPACES_TABLE} WHERE id = ?`, [id]);
  return rows[0];
}
async function indexNameCount(conn: mysql.Connection): Promise<number> {
  const [rows]: any = await conn.query(
    `SELECT COUNT(DISTINCT INDEX_NAME) AS c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [SPACES_TABLE, UNIQUE_INDEX]);
  return Number(rows[0].c);
}
async function columnNameCount(conn: mysql.Connection): Promise<number> {
  const [rows]: any = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [SPACES_TABLE, GLOBAL_ID_COLUMN]);
  return Number(rows[0].c);
}

/** Test-only HARD reset: unconditionally strip any leftover artifact by name,
 *  regardless of shape (the safe applyRollback intentionally refuses conflicts). */
async function hardResetArtifacts(conn: mysql.Connection): Promise<void> {
  if (await indexNameCount(conn) > 0) await conn.query(`DROP INDEX ${UNIQUE_INDEX} ON ${SPACES_TABLE}`);
  const [chk]: any = await conn.query(
    `SELECT COUNT(*) AS c FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE='CHECK'`,
    [SPACES_TABLE, CHECK_CONSTRAINT]);
  if (Number(chk[0].c) > 0) await conn.query(`ALTER TABLE ${SPACES_TABLE} DROP CHECK ${CHECK_CONSTRAINT}`);
  if (await columnNameCount(conn) > 0) await conn.query(`ALTER TABLE ${SPACES_TABLE} DROP COLUMN ${GLOBAL_ID_COLUMN}`);
}

async function freshBase(conn: mysql.Connection): Promise<void> {
  await hardResetArtifacts(conn);
  await conn.query("DELETE FROM space_bindings");
  await conn.query("DELETE FROM spaces");
  await conn.query("DELETE FROM model_versions");
  await conn.query("DELETE FROM models");
  await conn.query("DELETE FROM linked_models");
  await conn.query("DELETE FROM entities");
}

const GUID_A = "3VKKG6_QDBqgUlHMH5Q4EB";
const GUID_B = "2TYxeEXST7MP9bl8QCa9Ti";
const GUID_C = "2TYxeEXST7MP9bl8QCa9Od";

async function createSchemaObjects(conn: mysql.Connection): Promise<void> {
  await conn.query("CREATE TABLE entities (id INT NOT NULL AUTO_INCREMENT, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci");
  await conn.query("CREATE TABLE linked_models (id INT NOT NULL AUTO_INCREMENT, name VARCHAR(200) DEFAULT NULL, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci");
  await conn.query("CREATE TABLE models (id INT NOT NULL AUTO_INCREMENT, model_uuid CHAR(36) NOT NULL, linked_parent_id INT DEFAULT NULL, PRIMARY KEY (id), UNIQUE KEY uq_models_uuid (model_uuid), CONSTRAINT fk_m_linked_parent FOREIGN KEY (linked_parent_id) REFERENCES linked_models (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci");
  await conn.query("CREATE TABLE model_versions (id INT NOT NULL AUTO_INCREMENT, version_uuid CHAR(36) NOT NULL, model_id INT NOT NULL, version_number INT DEFAULT NULL, PRIMARY KEY (id), UNIQUE KEY uq_model_versions_uuid (version_uuid), UNIQUE KEY uq_model_version_number (model_id, version_number), CONSTRAINT model_versions_ibfk_1 FOREIGN KEY (model_id) REFERENCES models (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci");
  await conn.query("CREATE TABLE spaces (id INT NOT NULL AUTO_INCREMENT, space_uuid CHAR(36) NOT NULL, inventory_code VARCHAR(200) NOT NULL, inventory_code_normalized VARCHAR(200) NOT NULL, linked_model_id INT NOT NULL, name VARCHAR(255) DEFAULT NULL, status ENUM('active','absent','retired') NOT NULL DEFAULT 'active', PRIMARY KEY (id), UNIQUE KEY uq_spaces_uuid (space_uuid), UNIQUE KEY uq_spaces_scope_code (linked_model_id, inventory_code_normalized), CONSTRAINT fk_spaces_linked_model FOREIGN KEY (linked_model_id) REFERENCES linked_models (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci");
  await conn.query("CREATE TABLE space_bindings (id INT NOT NULL AUTO_INCREMENT, space_id INT NOT NULL, model_version_id INT NOT NULL, entity_id INT NOT NULL, ifc_guid VARCHAR(100) NOT NULL, inventory_code_snapshot VARCHAR(200) NOT NULL, name_snapshot VARCHAR(255) DEFAULT NULL, long_name_snapshot VARCHAR(255) DEFAULT NULL, PRIMARY KEY (id), UNIQUE KEY uq_binding_entity (entity_id), UNIQUE KEY uq_binding_space_version (space_id, model_version_id), CONSTRAINT fk_bindings_space FOREIGN KEY (space_id) REFERENCES spaces (id), CONSTRAINT fk_bindings_version FOREIGN KEY (model_version_id) REFERENCES model_versions (id), CONSTRAINT fk_bindings_entity FOREIGN KEY (entity_id) REFERENCES entities (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci");
}

async function runCases(conn: mysql.Connection, operationalDb: string | undefined, schema: string): Promise<void> {
  const [dbRow]: any = await conn.query("SELECT DATABASE() AS db");
  check("connection is bound to the disposable schema (not digital_twin)", dbRow[0].db === schema && dbRow[0].db !== operationalDb, `db=${dbRow[0].db}`);
  await createSchemaObjects(conn);

  // ---- A. CLEAN MULTI-VERSION SPACE ------------------------------------
  console.log("  [A] clean multi-version space");
  await freshBase(conn);
  let lm = await seedLinkedModel(conn, "A");
  let md = await seedModel(conn, lm);
  const vA1 = await seedVersion(conn, md, 1);
  const vA2 = await seedVersion(conn, md, 2);
  const spA = await seedSpace(conn, lm, "R-101", "Sala 101");
  await seedBinding(conn, spA.id, vA1, GUID_A, "R-101");
  await seedBinding(conn, spA.id, vA2, GUID_A, "R-101");
  const beforeA = await spaceRow(conn, spA.id);
  const resA = await applyForward(conn);
  const afterA = await spaceRow(conn, spA.id);
  check("A1 backfilled the single verified GlobalId", afterA.gid === GUID_A, `gid=${afterA.gid}`);
  check("A2 spaces.id unchanged", afterA.id === beforeA.id);
  check("A3 space_uuid unchanged", afterA.space_uuid === beforeA.space_uuid);
  check("A4 unique index EXACT", (await inspectIndex(conn)).state === "EXACT");
  check("A5 column EXACT", (await inspectColumn(conn)).state === "EXACT");
  check("A6 check EXACT", (await inspectCheck(conn)).state === "EXACT");
  check("A7 exactly one row backfilled", resA.rowsBackfilled === 1, `rows=${resA.rowsBackfilled}`);
  check("A8 legacy scope index intact (EXACT)", (await inspectLegacyScopeIndex(conn)).state === "EXACT");

  // ---- B. SAME GLOBALID IN DIFFERENT LINKED_MODELS ---------------------
  console.log("  [B] same GlobalId in different linked_models");
  await freshBase(conn);
  const lmB1 = await seedLinkedModel(conn, "B1");
  const lmB2 = await seedLinkedModel(conn, "B2");
  const mdB1 = await seedModel(conn, lmB1);
  const mdB2 = await seedModel(conn, lmB2);
  const vB1 = await seedVersion(conn, mdB1, 1);
  const vB2 = await seedVersion(conn, mdB2, 1);
  const spB1 = await seedSpace(conn, lmB1, "R-101", "Sala 101");
  const spB2 = await seedSpace(conn, lmB2, "R-101", "Sala 101");
  await seedBinding(conn, spB1.id, vB1, GUID_B, "R-101");
  await seedBinding(conn, spB2.id, vB2, GUID_B, "R-101");
  await applyForward(conn);
  check("B1 first linked_model space populated", (await spaceRow(conn, spB1.id)).gid === GUID_B);
  check("B2 second linked_model space populated", (await spaceRow(conn, spB2.id)).gid === GUID_B);
  check("B3 unique index allows same GUID across linked_models", (await inspectIndex(conn)).state === "EXACT");

  // ---- C. DUPLICATE TARGET IDENTITY ------------------------------------
  console.log("  [C] duplicate target identity (same linked_model + same GUID)");
  await freshBase(conn);
  const lmC = await seedLinkedModel(conn, "C");
  const mdC = await seedModel(conn, lmC);
  const vC = await seedVersion(conn, mdC, 1);
  const vC2 = await seedVersion(conn, mdC, 2);
  const spC1 = await seedSpace(conn, lmC, "R-101", "Sala 101");
  const spC2 = await seedSpace(conn, lmC, "R-102", "Sala 102");
  await seedBinding(conn, spC1.id, vC, GUID_A, "R-101");
  await seedBinding(conn, spC2.id, vC2, GUID_A, "R-102");
  await expectThrows("C1 forward refuses duplicate target identity", () => applyForward(conn));
  check("C2 no column created (refused before DDL)", !(await columnExists(conn)));
  check("C3 no unique index created", !(await indexExists(conn)));

  // ---- D. GLOBALID DRIFT -----------------------------------------------
  console.log("  [D] GlobalId drift (one space, two distinct GUIDs)");
  await freshBase(conn);
  const lmD = await seedLinkedModel(conn, "D");
  const mdD = await seedModel(conn, lmD);
  const vD1 = await seedVersion(conn, mdD, 1);
  const vD2 = await seedVersion(conn, mdD, 2);
  const spD = await seedSpace(conn, lmD, "R-101", "Sala 101");
  await seedBinding(conn, spD.id, vD1, GUID_A, "R-101");
  await seedBinding(conn, spD.id, vD2, GUID_B, "R-101");
  await expectThrows("D1 forward refuses GlobalId drift", () => applyForward(conn));
  check("D2 no column created", !(await columnExists(conn)));

  // ---- E. CASE-SENSITIVE IDENTITIES ------------------------------------
  console.log("  [E] case-sensitive identities (differ only by letter case)");
  await freshBase(conn);
  const gE1 = "AAAAAAAAAAAAAAAAAAAA1a";
  const gE2 = "AAAAAAAAAAAAAAAAAAAA1A";
  const lmE = await seedLinkedModel(conn, "E");
  const mdE = await seedModel(conn, lmE);
  const vE1 = await seedVersion(conn, mdE, 1);
  const vE2 = await seedVersion(conn, mdE, 2);
  const spE1 = await seedSpace(conn, lmE, "R-101", "Sala 101");
  const spE2 = await seedSpace(conn, lmE, "R-102", "Sala 102");
  await seedBinding(conn, spE1.id, vE1, gE1, "R-101");
  await seedBinding(conn, spE2.id, vE2, gE2, "R-102");
  await applyForward(conn);
  check("E1 first case-variant stored exactly", (await spaceRow(conn, spE1.id)).gid === gE1);
  check("E2 second case-variant stored exactly", (await spaceRow(conn, spE2.id)).gid === gE2);
  check("E3 unique index treats case-variants as distinct", (await inspectIndex(conn)).state === "EXACT");

  // ---- F. MISSING OR INVALID GLOBALID ----------------------------------
  console.log("  [F] missing or invalid GlobalId");
  for (const [label, guid] of [["F1 blank", "   "], ["F2 wrong-length", "3VKKG6_QDBqgUlHMH5Q4E"], ["F3 invalid-char", "3VKKG6_QDBqgUlHMH5Q4E!"]] as const) {
    await freshBase(conn);
    const lmF = await seedLinkedModel(conn, label);
    const mdF = await seedModel(conn, lmF);
    const vF = await seedVersion(conn, mdF, 1);
    const spF = await seedSpace(conn, lmF, "R-101", "Sala 101");
    await seedBinding(conn, spF.id, vF, guid, "R-101");
    await expectThrows(`${label} forward refuses invalid ifc_guid`, () => applyForward(conn));
  }

  // ---- G. RESTART / PARTIAL STATE --------------------------------------
  console.log("  [G] restart / partial state convergence");
  await freshBase(conn);
  const lmG = await seedLinkedModel(conn, "G");
  const mdG = await seedModel(conn, lmG);
  const vG = await seedVersion(conn, mdG, 1);
  const spG = await seedSpace(conn, lmG, "R-101", "Sala 101");
  await seedBinding(conn, spG.id, vG, GUID_A, "R-101");
  await conn.query(EXACT_COLUMN_DDL); // state B: exact column, not backfilled
  check("G1 state B detected (column present, not backfilled)", await columnExists(conn) && !(await indexExists(conn)) && (await spaceRow(conn, spG.id)).gid === null);
  await applyForward(conn);
  check("G2 forward converges from state B", (await spaceRow(conn, spG.id)).gid === GUID_A && (await inspectIndex(conn)).state === "EXACT");
  await conn.query(`DROP INDEX ${UNIQUE_INDEX} ON ${SPACES_TABLE}`); // state C
  check("G3 state C detected (column backfilled, index absent)", await columnExists(conn) && !(await indexExists(conn)) && (await spaceRow(conn, spG.id)).gid === GUID_A);
  await applyForward(conn);
  check("G4 forward converges from state C (index re-added)", (await inspectIndex(conn)).state === "EXACT");
  check("G5 no duplicate column after restart", await columnNameCount(conn) === 1);

  // ---- H. ALREADY APPLIED (idempotent re-run) --------------------------
  console.log("  [H] already applied");
  const resH = await applyForward(conn);
  check("H1 re-run adds no column", resH.columnAdded === false);
  check("H2 re-run adds no index", resH.indexAdded === false);
  check("H3 re-run backfills nothing", resH.rowsBackfilled === 0);
  check("H4 exactly one column", await columnNameCount(conn) === 1);
  check("H5 exactly one index", await indexNameCount(conn) === 1);

  // ---- I. CONFLICTING PREPOPULATED COLUMN ------------------------------
  console.log("  [I] conflicting prepopulated column");
  await freshBase(conn);
  const lmI = await seedLinkedModel(conn, "I");
  const mdI = await seedModel(conn, lmI);
  const vI = await seedVersion(conn, mdI, 1);
  const spI = await seedSpace(conn, lmI, "R-101", "Sala 101");
  await seedBinding(conn, spI.id, vI, GUID_A, "R-101");
  await conn.query(EXACT_COLUMN_DDL);
  await conn.query(`UPDATE ${SPACES_TABLE} SET ${GLOBAL_ID_COLUMN} = ? WHERE id = ?`, [GUID_B, spI.id]);
  await expectThrows("I1 forward refuses to overwrite a divergent prepopulated value", () => applyForward(conn));
  check("I2 prepopulated value left untouched", (await spaceRow(conn, spI.id)).gid === GUID_B);
  check("I3 no unique index created", !(await indexExists(conn)));

  // ---- J. ROLLBACK -----------------------------------------------------
  console.log("  [J] rollback");
  await freshBase(conn);
  const lmJ = await seedLinkedModel(conn, "J");
  const mdJ = await seedModel(conn, lmJ);
  const vJ1 = await seedVersion(conn, mdJ, 1);
  const vJ2 = await seedVersion(conn, mdJ, 2);
  const spJ = await seedSpace(conn, lmJ, "R-101", "Sala 101");
  await seedBinding(conn, spJ.id, vJ1, GUID_A, "R-101");
  await seedBinding(conn, spJ.id, vJ2, GUID_A, "R-101");
  await applyForward(conn);
  const beforeJ = await spaceRow(conn, spJ.id);
  const [bindingsBeforeJ]: any = await conn.query("SELECT id, ifc_guid FROM space_bindings WHERE space_id = ? ORDER BY id", [spJ.id]);
  const rb = await applyRollback(conn);
  check("J1 index removed", !(await indexExists(conn)) && rb.indexDropped);
  check("J2 check constraint removed", !(await checkConstraintExists(conn)) && rb.checkDropped);
  check("J3 column removed", !(await columnExists(conn)) && rb.columnDropped);
  const afterJ = await spaceRow(conn, spJ.id);
  check("J4 spaces.id preserved", afterJ.id === beforeJ.id);
  check("J5 space_uuid preserved", afterJ.space_uuid === beforeJ.space_uuid);
  check("J6 inventory_code preserved", afterJ.inventory_code === beforeJ.inventory_code);
  const [bindingsAfterJ]: any = await conn.query("SELECT id, ifc_guid FROM space_bindings WHERE space_id = ? ORDER BY id", [spJ.id]);
  check("J7 bindings unchanged", JSON.stringify(bindingsAfterJ) === JSON.stringify(bindingsBeforeJ));
  const rb2 = await applyRollback(conn);
  check("J8 rollback second run is a safe no-op", !rb2.indexDropped && !rb2.checkDropped && !rb2.columnDropped);

  // ---- K. EXISTING COLUMN WITH WRONG SHAPE -----------------------------
  console.log("  [K] existing column with wrong type/collation");
  await freshBase(conn);
  const lmK = await seedLinkedModel(conn, "K");
  const mdK = await seedModel(conn, lmK);
  const vK = await seedVersion(conn, mdK, 1);
  const spK = await seedSpace(conn, lmK, "R-101", "Sala 101");
  await seedBinding(conn, spK.id, vK, GUID_A, "R-101");
  await conn.query(`ALTER TABLE ${SPACES_TABLE} ADD COLUMN ${GLOBAL_ID_COLUMN} VARCHAR(22) NULL`); // wrong type+collation
  check("K1 wrong column classified CONFLICTING", (await inspectColumn(conn)).state === "CONFLICTING");
  await expectThrows("K2 forward fails on conflicting column before data change", () => applyForward(conn));
  check("K3 no unique index created", !(await indexExists(conn)));
  check("K4 conflicting column left untouched", (await inspectColumn(conn)).state === "CONFLICTING");

  // ---- L. EXISTING SAME-NAME INDEX WITH WRONG SHAPE --------------------
  console.log("  [L] existing same-name index with wrong uniqueness/order");
  await freshBase(conn);
  const lmL = await seedLinkedModel(conn, "L");
  const mdL = await seedModel(conn, lmL);
  const vL = await seedVersion(conn, mdL, 1);
  const spL = await seedSpace(conn, lmL, "R-101", "Sala 101");
  await seedBinding(conn, spL.id, vL, GUID_A, "R-101");
  await conn.query(EXACT_COLUMN_DDL);
  await conn.query(`CREATE INDEX ${UNIQUE_INDEX} ON ${SPACES_TABLE} (${GLOBAL_ID_COLUMN}, linked_model_id)`); // non-unique, wrong order
  check("L1 wrong index classified CONFLICTING", (await inspectIndex(conn)).state === "CONFLICTING");
  await expectThrows("L2 forward fails on conflicting index", () => applyForward(conn));

  // ---- M. EXISTING SAME-NAME CHECK WITH WRONG EXPRESSION ---------------
  console.log("  [M] existing same-name CHECK with wrong expression");
  await freshBase(conn);
  const lmM = await seedLinkedModel(conn, "M");
  const mdM = await seedModel(conn, lmM);
  const vM = await seedVersion(conn, mdM, 1);
  const spM = await seedSpace(conn, lmM, "R-101", "Sala 101");
  await seedBinding(conn, spM.id, vM, GUID_A, "R-101");
  await conn.query(EXACT_COLUMN_DDL);
  await conn.query(`ALTER TABLE ${SPACES_TABLE} ADD CONSTRAINT ${CHECK_CONSTRAINT} CHECK (${GLOBAL_ID_COLUMN} IS NULL OR CHAR_LENGTH(${GLOBAL_ID_COLUMN}) = 20)`);
  check("M1 wrong CHECK classified CONFLICTING", (await inspectCheck(conn)).state === "CONFLICTING");
  await expectThrows("M2 forward fails on conflicting CHECK", () => applyForward(conn));

  // ---- N. MULTI-ROW CONFLICTING BACKFILL -> ZERO PARTIAL UPDATES -------
  console.log("  [N] multi-row conflict produces zero partial updates");
  await freshBase(conn);
  const lmN = await seedLinkedModel(conn, "N");
  const mdN = await seedModel(conn, lmN);
  const vN1 = await seedVersion(conn, mdN, 1);
  const vN2 = await seedVersion(conn, mdN, 2);
  const vN3 = await seedVersion(conn, mdN, 3);
  const spN1 = await seedSpace(conn, lmN, "R-101", "Sala 101");
  const spN2 = await seedSpace(conn, lmN, "R-102", "Sala 102");
  const spN3 = await seedSpace(conn, lmN, "R-103", "Sala 103");
  await seedBinding(conn, spN1.id, vN1, GUID_A, "R-101");
  await seedBinding(conn, spN2.id, vN2, GUID_B, "R-102");
  await seedBinding(conn, spN3.id, vN3, GUID_C, "R-103");
  await conn.query(EXACT_COLUMN_DDL);
  await conn.query(`UPDATE ${SPACES_TABLE} SET ${GLOBAL_ID_COLUMN} = ? WHERE id = ?`, ["ZZZZZZZZZZZZZZZZZZZZZZ", spN3.id]); // conflicts with GUID_C
  await expectThrows("N1 forward fails on multi-row conflict", () => applyForward(conn));
  check("N2 first row not partially updated (still NULL)", (await spaceRow(conn, spN1.id)).gid === null);
  check("N3 second row not partially updated (still NULL)", (await spaceRow(conn, spN2.id)).gid === null);
  check("N4 conflicting third value unchanged", (await spaceRow(conn, spN3.id)).gid === "ZZZZZZZZZZZZZZZZZZZZZZ");
  check("N5 no unique index created", !(await indexExists(conn)));

  // ---- O. G7 LINKED-MODEL MISMATCH -------------------------------------
  console.log("  [O] G7 chain-integrity mismatch");
  await freshBase(conn);
  const lmO = await seedLinkedModel(conn, "O");
  const lmOther = await seedLinkedModel(conn, "O-other");
  const mdOmis = await seedModel(conn, lmOther); // model's linked_parent != space's linked_model
  const vO = await seedVersion(conn, mdOmis, 1);
  const spO = await seedSpace(conn, lmO, "R-101", "Sala 101");
  await seedBinding(conn, spO.id, vO, GUID_A, "R-101");
  await expectThrows("O1 forward fails on linked_model mismatch (valid FK chain)", () => applyForward(conn));
  // NULL linked_parent variant
  await freshBase(conn);
  const lmO2 = await seedLinkedModel(conn, "O2");
  const mdOnull = await seedModel(conn, null); // NULL linked_parent
  const vO2 = await seedVersion(conn, mdOnull, 1);
  const spO2 = await seedSpace(conn, lmO2, "R-101", "Sala 101");
  await seedBinding(conn, spO2.id, vO2, GUID_A, "R-101");
  await expectThrows("O2 forward fails on NULL linked_parent", () => applyForward(conn));

  // ---- P. CLI DATABASE-CONFIRMATION CONTRACT ---------------------------
  console.log("  [P] CLI confirmation contract");
  check("P1 parseCliArgs accepts a valid forward invocation", parseCliArgs(["--confirm-database", "digital_twin", "--maintenance-confirmed"]).direction === "forward");
  let pThrew = false; try { parseCliArgs(["--confirm-database", "digital_twin", "--maintenance-confirmed", "--oops"]); } catch { pThrew = true; }
  check("P2 parseCliArgs rejects unknown arguments", pThrew);
  // assertConfirmedTarget guards two INDEPENDENT conditions. Test each in isolation;
  // the live connection is the disposable schema, never a foreign database.
  const savedDbName = process.env.DB_NAME;
  try {
    // P3a: --confirm-database differs from DB_NAME -> rejected (regardless of live DB).
    process.env.DB_NAME = schema; // make DB_NAME == live DB so only the arg mismatches
    await expectThrows("P3a assertConfirmedTarget rejects arg != DB_NAME",
      () => assertConfirmedTarget(conn, { direction: "forward", confirmDatabase: `${schema}_wrong`, maintenanceConfirmed: true }));
    // P3b: --confirm-database == DB_NAME, but SELECT DATABASE() (disposable schema) differs.
    process.env.DB_NAME = `${schema}_elsewhere`; // arg will equal this, but live DB is `schema`
    await expectThrows("P3b assertConfirmedTarget rejects DB_NAME != SELECT DATABASE()",
      () => assertConfirmedTarget(conn, { direction: "forward", confirmDatabase: `${schema}_elsewhere`, maintenanceConfirmed: true }));
  } finally {
    process.env.DB_NAME = savedDbName; // always restore; never connected to any foreign DB
  }
  // P3c: system-schema helper rejects case variants and permits real targets.
  check("P3c isSystemSchema rejects case variants", ["mysql", "MYSQL", "Mysql", "information_schema", "INFORMATION_SCHEMA", "performance_schema", "SYS"].every(isSystemSchema));
  check("P3c isSystemSchema permits real targets", !isSystemSchema("digital_twin") && !isSystemSchema("oswadt_spaceguid_migtest_example"));

  // ---- Q. ROLLBACK REFUSES WRONG-SHAPED ARTIFACTS ----------------------
  console.log("  [Q] rollback refuses wrong-shaped artifacts");
  // Q1 wrong column
  await freshBase(conn);
  await conn.query(`ALTER TABLE ${SPACES_TABLE} ADD COLUMN ${GLOBAL_ID_COLUMN} VARCHAR(22) NULL`);
  await expectThrows("Q1 rollback refuses a wrong-shaped column", () => applyRollback(conn));
  check("Q1b conflicting column left in place", await columnExists(conn));
  // Q2 wrong index (exact column present)
  await freshBase(conn);
  await conn.query(EXACT_COLUMN_DDL);
  await conn.query(`CREATE INDEX ${UNIQUE_INDEX} ON ${SPACES_TABLE} (${GLOBAL_ID_COLUMN}, linked_model_id)`);
  await expectThrows("Q2 rollback refuses a wrong-shaped same-name index", () => applyRollback(conn));
  check("Q2b conflicting index and column left in place", (await indexExists(conn)) && (await columnExists(conn)));
  // Q3 wrong check (exact column present)
  await freshBase(conn);
  await conn.query(EXACT_COLUMN_DDL);
  await conn.query(`ALTER TABLE ${SPACES_TABLE} ADD CONSTRAINT ${CHECK_CONSTRAINT} CHECK (${GLOBAL_ID_COLUMN} IS NULL OR CHAR_LENGTH(${GLOBAL_ID_COLUMN}) = 20)`);
  await expectThrows("Q3 rollback refuses a wrong-shaped same-name CHECK", () => applyRollback(conn));
  check("Q3b conflicting check left in place", await checkConstraintExists(conn));

  // ---- R. ALREADY-APPLIED EXACT DEFINITIONS REMAIN IDEMPOTENT ----------
  console.log("  [R] already-applied exact definitions idempotent");
  await freshBase(conn);
  const lmR = await seedLinkedModel(conn, "R");
  const mdR = await seedModel(conn, lmR);
  const vR = await seedVersion(conn, mdR, 1);
  const spR = await seedSpace(conn, lmR, "R-101", "Sala 101");
  await seedBinding(conn, spR.id, vR, GUID_A, "R-101");
  await applyForward(conn);
  check("R1 column EXACT after apply", (await inspectColumn(conn)).state === "EXACT");
  check("R2 check EXACT after apply", (await inspectCheck(conn)).state === "EXACT");
  check("R3 index EXACT after apply", (await inspectIndex(conn)).state === "EXACT");
  const resR = await applyForward(conn); // exact re-run
  check("R4 re-run is a pure no-op", !resR.columnAdded && !resR.checkAdded && !resR.indexAdded && resR.rowsBackfilled === 0);
  check("R5 still exactly one column and one index", (await columnNameCount(conn)) === 1 && (await indexNameCount(conn)) === 1);

  // ---- S. CHECK-CLAUSE CASE SENSITIVITY + ENFORCEMENT ------------------
  console.log("  [S] CHECK clause case-sensitivity and enforcement");
  // helper: fresh valid data with the EXACT column present, ready for a manual CHECK
  const seedWithExactColumn = async (label: string): Promise<void> => {
    await freshBase(conn);
    const lmS = await seedLinkedModel(conn, label);
    const mdS = await seedModel(conn, lmS);
    const vS = await seedVersion(conn, mdS, 1);
    const spS = await seedSpace(conn, lmS, "R-101", "Sala 101");
    await seedBinding(conn, spS.id, vS, GUID_A, "R-101");
    await conn.query(EXACT_COLUMN_DDL);
  };

  // S1 exact expected check (created by the real migration) is EXACT.
  await seedWithExactColumn("S1");
  await conn.query(`ALTER TABLE ${SPACES_TABLE} ADD CONSTRAINT ${CHECK_CONSTRAINT} CHECK (${GLOBAL_ID_COLUMN} IS NULL OR ${GLOBAL_ID_COLUMN} REGEXP '^[0-9A-Za-z_$]{22}$')`);
  check("S1 exact case-sensitive alphabet -> EXACT", (await inspectCheck(conn)).state === "EXACT");

  // S2 lowercase-only alphabet -> CONFLICTING; forward and rollback both refuse.
  await seedWithExactColumn("S2");
  await conn.query(`ALTER TABLE ${SPACES_TABLE} ADD CONSTRAINT ${CHECK_CONSTRAINT} CHECK (${GLOBAL_ID_COLUMN} IS NULL OR ${GLOBAL_ID_COLUMN} REGEXP '^[0-9a-z_$]{22}$')`);
  check("S2a lowercase-only alphabet -> CONFLICTING", (await inspectCheck(conn)).state === "CONFLICTING");
  await expectThrows("S2b forward refuses lowercase-only CHECK", () => applyForward(conn));
  await expectThrows("S2c rollback refuses lowercase-only CHECK", () => applyRollback(conn));
  check("S2d conflicting CHECK left in place", await checkConstraintExists(conn));

  // S3 uppercase-only alphabet -> CONFLICTING.
  await seedWithExactColumn("S3");
  await conn.query(`ALTER TABLE ${SPACES_TABLE} ADD CONSTRAINT ${CHECK_CONSTRAINT} CHECK (${GLOBAL_ID_COLUMN} IS NULL OR ${GLOBAL_ID_COLUMN} REGEXP '^[0-9A-Z_$]{22}$')`);
  check("S3 uppercase-only alphabet -> CONFLICTING", (await inspectCheck(conn)).state === "CONFLICTING");

  // S4 different length -> CONFLICTING.
  await seedWithExactColumn("S4");
  await conn.query(`ALTER TABLE ${SPACES_TABLE} ADD CONSTRAINT ${CHECK_CONSTRAINT} CHECK (${GLOBAL_ID_COLUMN} IS NULL OR ${GLOBAL_ID_COLUMN} REGEXP '^[0-9A-Za-z_$]{21}$')`);
  check("S4 different length {21} -> CONFLICTING", (await inspectCheck(conn)).state === "CONFLICTING");

  // S5 harmless formatting differences (extra whitespace, lowercase regexp keyword,
  // backticks) still normalise to EXACT — MySQL canonicalises storage and our
  // quote-aware normaliser handles the rest without touching the literal.
  await seedWithExactColumn("S5");
  await conn.query(`ALTER TABLE ${SPACES_TABLE} ADD CONSTRAINT ${CHECK_CONSTRAINT} CHECK ((\`${GLOBAL_ID_COLUMN}\`   IS   NULL) OR   \`${GLOBAL_ID_COLUMN}\` regexp '^[0-9A-Za-z_$]{22}$')`);
  check("S5 harmless formatting differences -> EXACT", (await inspectCheck(conn)).state === "EXACT");

  // S7 correct clause but NOT ENFORCED -> CONFLICTING (real non-enforced constraint).
  await seedWithExactColumn("S7");
  await conn.query(`ALTER TABLE ${SPACES_TABLE} ADD CONSTRAINT ${CHECK_CONSTRAINT} CHECK (${GLOBAL_ID_COLUMN} IS NULL OR ${GLOBAL_ID_COLUMN} REGEXP '^[0-9A-Za-z_$]{22}$')`);
  await conn.query(`ALTER TABLE ${SPACES_TABLE} ALTER CHECK ${CHECK_CONSTRAINT} NOT ENFORCED`);
  check("S7a correct clause + NOT ENFORCED -> CONFLICTING", (await inspectCheck(conn)).state === "CONFLICTING");
  await expectThrows("S7b forward refuses a non-enforced CHECK", () => applyForward(conn));
  await expectThrows("S7c rollback refuses a non-enforced CHECK", () => applyRollback(conn));

  // ---- T. LEGACY REFERENCE-INDEX EXACT INSPECTION ----------------------
  console.log("  [T] legacy Reference-index exact inspection");
  // T1 exact legacy index (the production shape) permits forward.
  await freshBase(conn);
  const lmT = await seedLinkedModel(conn, "T1");
  const mdT = await seedModel(conn, lmT);
  const vT = await seedVersion(conn, mdT, 1);
  const spT = await seedSpace(conn, lmT, "R-101", "Sala 101");
  await seedBinding(conn, spT.id, vT, GUID_A, "R-101");
  check("T1a legacy index EXACT before forward", (await inspectLegacyScopeIndex(conn)).state === "EXACT");
  await applyForward(conn);
  check("T1b forward succeeds and legacy index remains EXACT", (await inspectLegacyScopeIndex(conn)).state === "EXACT" && (await inspectColumn(conn)).state === "EXACT");

  // For T2–T4 the legacy index must be altered. The FK on linked_model_id relies on
  // that index's leading column, so detach it first (disposable schema only).
  await freshBase(conn);
  const lmT2 = await seedLinkedModel(conn, "T2");
  const mdT2 = await seedModel(conn, lmT2);
  const vT2 = await seedVersion(conn, mdT2, 1);
  const spT2 = await seedSpace(conn, lmT2, "R-101", "Sala 101");
  await seedBinding(conn, spT2.id, vT2, GUID_A, "R-101");
  await conn.query(`ALTER TABLE ${SPACES_TABLE} DROP FOREIGN KEY fk_spaces_linked_model`);

  // T2 missing legacy index -> forward fails before adding ifc_global_id.
  await conn.query(`DROP INDEX ${LEGACY_SCOPE_INDEX} ON ${SPACES_TABLE}`);
  check("T2a legacy index ABSENT", (await inspectLegacyScopeIndex(conn)).state === "ABSENT");
  await expectThrows("T2b forward fails when legacy index is missing", () => applyForward(conn));
  check("T2c no ifc_global_id column or unique index created", !(await columnExists(conn)) && !(await indexExists(conn)));

  // T3 same-name NON-UNIQUE legacy index -> forward fails before DDL.
  await conn.query(`CREATE INDEX ${LEGACY_SCOPE_INDEX} ON ${SPACES_TABLE} (linked_model_id, inventory_code_normalized)`);
  check("T3a non-unique legacy index CONFLICTING", (await inspectLegacyScopeIndex(conn)).state === "CONFLICTING");
  await expectThrows("T3b forward fails on non-unique legacy index", () => applyForward(conn));
  check("T3c no ifc_global_id column created", !(await columnExists(conn)));
  await conn.query(`DROP INDEX ${LEGACY_SCOPE_INDEX} ON ${SPACES_TABLE}`);

  // T4 same-name legacy index with REVERSED columns -> forward fails before DDL.
  await conn.query(`CREATE UNIQUE INDEX ${LEGACY_SCOPE_INDEX} ON ${SPACES_TABLE} (inventory_code_normalized, linked_model_id)`);
  check("T4a reversed-column legacy index CONFLICTING", (await inspectLegacyScopeIndex(conn)).state === "CONFLICTING");
  await expectThrows("T4b forward fails on reversed-column legacy index", () => applyForward(conn));
  check("T4c no ifc_global_id column created", !(await columnExists(conn)));

  // T5 the failure left the incorrect legacy-index state untouched and created no
  // Stage 0A artifact.
  check("T5 no Stage 0A artifact; conflicting legacy index untouched",
    !(await columnExists(conn)) && !(await indexExists(conn)) && !(await checkConstraintExists(conn)) &&
    (await inspectLegacyScopeIndex(conn)).state === "CONFLICTING");
}

async function main() {
  const operationalDb = process.env.DB_NAME;
  const schema = `oswadt_spaceguid_migtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  if (schema === operationalDb) throw new Error("refusing to reuse the operational database name");

  const baseConfig = {
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, multipleStatements: false,
  } as any;

  const server = await mysql.createConnection(baseConfig);
  let schemaCreated = false;
  let schemaDropped = false;
  let disposableConnectionClosed = false;
  let serverConnectionClosed = false;
  let conn: mysql.Connection | undefined;
  let primaryError: unknown;
  // Cleanup errors are tracked SEPARATELY so one failure never blocks the next
  // cleanup attempt and none is silently swallowed.
  let disposableConnectionCloseError: unknown;
  let schemaDropError: unknown;
  let serverConnectionCloseError: unknown;

  try {
    console.log(JSON.stringify({ event: "space_globalid_self_test_start", disposableSchema: schema, operationalDatabase: operationalDb, note: "operational database is never selected or modified" }));
    await server.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    schemaCreated = true;
    // If this connection fails to open, cleanup below still DROPs the schema.
    conn = await mysql.createConnection({ ...baseConfig, database: schema } as any);
    await runCases(conn, operationalDb, schema);
  } catch (e) {
    primaryError = e;
  } finally {
    // Always attempt EVERY cleanup step, independently, even if an earlier one failed.
    if (conn) {
      try { await conn.end(); disposableConnectionClosed = true; }
      catch (e) { disposableConnectionCloseError = e; console.error(`cleanup: failed closing disposable connection: ${String((e as any)?.message ?? e)}`); }
    } else {
      disposableConnectionClosed = true; // nothing was opened
    }
    if (schemaCreated) {
      try { await server.query(`DROP DATABASE \`${schema}\``); schemaDropped = true; }
      catch (e) { schemaDropError = e; console.error(`cleanup: FAILED to drop disposable schema '${schema}'. Manual cleanup required: DROP DATABASE \`${schema}\`; -- ${String((e as any)?.message ?? e)}`); }
    }
    try { await server.end(); serverConnectionClosed = true; }
    catch (e) { serverConnectionCloseError = e; console.error(`cleanup: failed closing server connection: ${String((e as any)?.message ?? e)}`); }
  }

  const cleanupErrors = [disposableConnectionCloseError, schemaDropError, serverConnectionCloseError].filter((e) => e !== undefined);
  const primaryErrorPresent = primaryError !== undefined || failures > 0;
  const outcome = classifyOutcome({ primaryErrorPresent, cleanupErrorCount: cleanupErrors.length });

  console.log(JSON.stringify({
    event: "space_globalid_self_test_end",
    disposableSchema: schema, schemaCreated, schemaDropped,
    disposableConnectionClosed, serverConnectionClosed,
    primaryErrorPresent, cleanupErrorCount: cleanupErrors.length,
    passes, failures,
  }));

  if (primaryError !== undefined) console.error(`primary error: ${String((primaryError as any)?.message ?? primaryError)}`);
  if (failures > 0) console.error(`assertion failures: ${failures}`);
  if (schemaCreated && !schemaDropped) console.error(`DISPOSABLE SCHEMA NOT DROPPED — run manually: DROP DATABASE \`${schema}\`;`);

  console.log(`\n  ${passes} checks passed, ${failures} failed. outcome=${outcome.failureReason}`);
  // A cleanup failure (e.g. an undropped schema) must NEVER exit successfully.
  if (!outcome.success) process.exit(1);
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
