/**
 * Disposable-schema integration self-test for the Stage 0B IfcSpace-GlobalId
 * RUNTIME identity switch (ADR-0051 §4/§5/§6/§7). It exercises the REAL Stage 0B
 * database functions AND the REAL `persistSpaceIdentities` service path (where
 * deterministic) plus REAL mysql2 error objects against a brand-new throwaway
 * schema on the configured MySQL SERVER — never the operational database named by
 * DB_NAME (digital_twin).
 *
 * How it avoids the operational database: the schema is created via a server-only
 * connection (no database selected), then DB_NAME is repointed to the disposable
 * schema BEFORE the singleton SpaceDatabase is dynamically imported, so every
 * Stage 0B function and the service run bound to the disposable schema. The
 * original DB_NAME is restored in `finally`. SELECT DATABASE() is asserted to equal
 * the disposable schema and to differ from the operational one.
 *
 * Honest boundary: the DB/service boundary is exercised with real MySQL — the real
 * unique indexes, real ER_DUP_ENTRY objects and their structured translation, the
 * atomic binding/canonical INSERT…SELECT, the canonical/binding integrity query, the
 * deterministic legacy/Reference-update collisions raised by the SERVICE, and the
 * compensation delete. A truly CONCURRENT canonical create race cannot be staged
 * deterministically in a single-process fixture, so the canonical re-resolution
 * BRANCH is unit-tested with the fake DB (spaceIdentity.test.ts case M); here we
 * prove the real primitive it relies on: a real canonical ER_DUP_ENTRY classified
 * as `canonical_globalid` and re-resolved to the SAME identity, never by Reference.
 * The complete activation transaction (modelUploadService orchestration) is covered
 * by the fake upload-flow suites.
 *
 * Cleanup is robust AND fatal: the singleton pool disconnect, the disposable
 * connection close, the schema drop and the server connection close are tracked
 * SEPARATELY, all attempted, and ANY of them failing (or a primary error) forces a
 * non-zero exit — a run can never silently leave a disposable schema or pool behind.
 *
 * Usage (safe): cd back && npx tsx scripts/spaceGlobalIdRuntimeSelfTest.ts
 */
import "dotenv/config";
import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { classifyOutcome } from "./migrations/selfTestOutcome.ts";
import {
  classifyDuplicateKey, duplicateKeyIndexName, isDuplicateKeyError,
  CANONICAL_GLOBALID_INDEX, LEGACY_SCOPE_INDEX,
} from "../utils/mysqlDuplicateKey.ts";
import { isValidIfcGlobalId } from "../utils/ifcGlobalId.ts";

let failures = 0;
let passes = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) { passes += 1; console.log(`    PASS  ${name}`); }
  else { failures += 1; console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
async function captureError(fn: () => Promise<unknown>): Promise<any | null> {
  try { await fn(); return null; } catch (e) { return e; }
}
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const GUID_A = "3VKKG6_QDBqgUlHMH5Q4EB";
const GUID_B = "2TYxeEXST7MP9bl8QCa9Ti";
const GUID_C = "2TYxeEXST7MP9bl8QCa9Od";
const GUID_CASE_LOWER = "AAAAAAAAAAAAAAAAAAAA1a";
const GUID_CASE_UPPER = "AAAAAAAAAAAAAAAAAAAA1A";

async function createSchemaObjects(conn: mysql.Connection): Promise<void> {
  await conn.query("CREATE TABLE entities (id INT NOT NULL AUTO_INCREMENT, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci");
  await conn.query("CREATE TABLE linked_models (id INT NOT NULL AUTO_INCREMENT, name VARCHAR(200) DEFAULT NULL, spatial_authority_model_id INT DEFAULT NULL, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci");
  await conn.query("CREATE TABLE models (id INT NOT NULL AUTO_INCREMENT, model_uuid CHAR(36) NOT NULL, linked_parent_id INT DEFAULT NULL, PRIMARY KEY (id), UNIQUE KEY uq_models_uuid (model_uuid), CONSTRAINT fk_m_linked_parent FOREIGN KEY (linked_parent_id) REFERENCES linked_models (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci");
  await conn.query("CREATE TABLE model_versions (id INT NOT NULL AUTO_INCREMENT, version_uuid CHAR(36) NOT NULL, model_id INT NOT NULL, version_number INT DEFAULT NULL, PRIMARY KEY (id), UNIQUE KEY uq_model_versions_uuid (version_uuid), CONSTRAINT model_versions_ibfk_1 FOREIGN KEY (model_id) REFERENCES models (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci");
  await conn.query(`CREATE TABLE spaces (
      id INT NOT NULL AUTO_INCREMENT,
      space_uuid CHAR(36) NOT NULL,
      ifc_global_id CHAR(22) CHARACTER SET ascii COLLATE ascii_bin NULL,
      inventory_code VARCHAR(200) NOT NULL,
      inventory_code_normalized VARCHAR(200) NOT NULL,
      linked_model_id INT NOT NULL,
      name VARCHAR(255) DEFAULT NULL,
      status ENUM('active','absent','retired') NOT NULL DEFAULT 'active',
      PRIMARY KEY (id),
      UNIQUE KEY uq_spaces_uuid (space_uuid),
      UNIQUE KEY uq_spaces_scope_code (linked_model_id, inventory_code_normalized),
      UNIQUE KEY uq_spaces_linked_model_ifc_global_id (linked_model_id, ifc_global_id),
      CONSTRAINT chk_spaces_ifc_global_id_format CHECK (ifc_global_id IS NULL OR ifc_global_id REGEXP '^[0-9A-Za-z_$]{22}$'),
      CONSTRAINT fk_spaces_linked_model FOREIGN KEY (linked_model_id) REFERENCES linked_models (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  await conn.query(`CREATE TABLE space_bindings (
      id INT NOT NULL AUTO_INCREMENT, space_id INT NOT NULL, model_version_id INT NOT NULL,
      entity_id INT NOT NULL, ifc_guid VARCHAR(100) NOT NULL, inventory_code_snapshot VARCHAR(200) NOT NULL,
      name_snapshot VARCHAR(255) DEFAULT NULL, long_name_snapshot VARCHAR(255) DEFAULT NULL,
      binding_status ENUM('active','superseded') NOT NULL DEFAULT 'active',
      PRIMARY KEY (id), UNIQUE KEY uq_binding_entity (entity_id),
      UNIQUE KEY uq_binding_space_version (space_id, model_version_id),
      CONSTRAINT fk_bindings_space FOREIGN KEY (space_id) REFERENCES spaces (id),
      CONSTRAINT fk_bindings_version FOREIGN KEY (model_version_id) REFERENCES model_versions (id),
      CONSTRAINT fk_bindings_entity FOREIGN KEY (entity_id) REFERENCES entities (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
}

async function seedLinkedModel(conn: mysql.Connection, name: string): Promise<number> {
  const [r]: any = await conn.query("INSERT INTO linked_models (name) VALUES (?)", [name]);
  return Number(r.insertId);
}
async function seedModel(conn: mysql.Connection, linkedModelId: number): Promise<number> {
  const [m]: any = await conn.query("INSERT INTO models (model_uuid, linked_parent_id) VALUES (?, ?)", [crypto.randomUUID(), linkedModelId]);
  return Number(m.insertId);
}
async function seedVersion(conn: mysql.Connection, modelId: number): Promise<number> {
  const [v]: any = await conn.query("INSERT INTO model_versions (version_uuid, model_id, version_number) VALUES (?, ?, 1)", [crypto.randomUUID(), modelId]);
  return Number(v.insertId);
}
async function seedEntity(conn: mysql.Connection): Promise<number> {
  const [r]: any = await conn.query("INSERT INTO entities () VALUES ()");
  return Number(r.insertId);
}
async function spaceRowById(conn: mysql.Connection, id: number): Promise<any> {
  const [rows]: any = await conn.query("SELECT id, space_uuid, ifc_global_id, inventory_code, inventory_code_normalized, name FROM spaces WHERE id = ?", [id]);
  return rows[0];
}
async function spacesCount(conn: mysql.Connection, linkedModelId: number): Promise<number> {
  const [rows]: any = await conn.query("SELECT COUNT(*) AS c FROM spaces WHERE linked_model_id = ?", [linkedModelId]);
  return Number(rows[0].c);
}
// The identity Reference is provided as a plain field and resolved by a self-test
// resolver (installed below), so this script never names the property set — the
// architecture guard keeps that source in back/identity/ only.
function candidate(guid: string, reference: string, entityId: number) {
  return { guid, name: `Sala ${reference}`, longName: null, entityId, reference };
}
// The lossless occurrence contract is MANDATORY (ADR-0051 §1-v3): derive occurrences
// (one per candidate GlobalId, carrying its distinct entity id) exactly as the
// orchestrator does, and pass them to the REAL service.
function occFor(cands: Array<{ guid: string; entityId: number; name?: string | null; longName?: string | null }>) {
  return cands.map((c) => ({ guid: c.guid, name: c.name ?? null, longName: c.longName ?? null, entityId: c.entityId }));
}
async function persist(service: any, args: any) {
  return service.persistSpaceIdentities({ ...args, occurrences: "occurrences" in args ? args.occurrences : occFor(args.candidates) });
}

async function runCases(
  conn: mysql.Connection,
  conn2: mysql.Connection,
  spaceDb: any,
  service: { persistSpaceIdentities: any; TransitionalReferenceCollisionError: any; setSpaceIdentityResolver: (r: any) => void;
    __setAfterReferencePrecheckHook: (fn: any) => void; referenceLockName: (db: string, lm: number) => string },
  operationalDb: string | undefined,
  schema: string,
): Promise<void> {
  const [dbRow]: any = await conn.query("SELECT DATABASE() AS db");
  check("connection is bound to the disposable schema (not digital_twin)",
    dbRow[0].db === schema && dbRow[0].db !== operationalDb, `db=${dbRow[0].db}`);

  // Install a self-test identity resolver that reads the plain `reference` field, so
  // this script never names the identity property set (architecture guard).
  service.setSpaceIdentityResolver({
    resolve: async (c: any) => ({
      status: "valid", rawValue: c.reference, normalizedValue: c.reference,
      source: "SelfTest.Reference", reasons: [], resolverId: "selftest", resolvedAt: new Date().toISOString(), guid: c.guid,
    }),
  });

  await createSchemaObjects(conn);
  await spaceDb.assertCanonicalSpaceSchema();
  check("assertCanonicalSpaceSchema passes on the EXACT Stage 0A-shaped disposable schema", true);

  // ---- A. CANONICAL GLOBALID UNIQUE CONFLICT (real error + translation) --------
  console.log("  [A] canonical GlobalId unique conflict");
  const lmA = await seedLinkedModel(conn, "A");
  const first = await spaceDb.createSpace({ linkedModelId: lmA, ifcGlobalId: GUID_A, inventoryCode: "R-101", inventoryCodeNormalized: "R-101", name: "Sala 101" });
  const errA = await captureError(() => spaceDb.createSpace({ linkedModelId: lmA, ifcGlobalId: GUID_A, inventoryCode: "R-102", inventoryCodeNormalized: "R-102", name: "dup" }));
  check("A1 real duplicate-key error raised", isDuplicateKeyError(errA), `err=${errA?.code}`);
  check("A2 errno 1062 / sqlState 23000", errA?.errno === 1062 && errA?.sqlState === "23000", `errno=${errA?.errno} sqlState=${errA?.sqlState}`);
  check("A3 duplicate index is the canonical GlobalId index", duplicateKeyIndexName(errA) === CANONICAL_GLOBALID_INDEX, `index=${duplicateKeyIndexName(errA)}`);
  check("A4 classified as canonical_globalid (the re-resolution branch's real primitive)", classifyDuplicateKey(errA) === "canonical_globalid");
  const reresolved = await spaceDb.findByScopeAndGlobalId(lmA, GUID_A);
  check("A5 canonical re-resolution returns the SAME persistent identity, not by Reference", Number(reresolved.id) === Number(first.spaceId) && reresolved.inventory_code_normalized === "R-101");

  // ---- B. LEGACY REFERENCE UNIQUE CONFLICT (real error + translation) ----------
  console.log("  [B] legacy Reference unique conflict");
  const lmB = await seedLinkedModel(conn, "B");
  await spaceDb.createSpace({ linkedModelId: lmB, ifcGlobalId: GUID_A, inventoryCode: "R-101", inventoryCodeNormalized: "R-101", name: "Sala 101" });
  const errB = await captureError(() => spaceDb.createSpace({ linkedModelId: lmB, ifcGlobalId: GUID_B, inventoryCode: "R-101", inventoryCodeNormalized: "R-101", name: "diff-guid" }));
  check("B1 real duplicate-key error raised", isDuplicateKeyError(errB));
  check("B2 duplicate index is the legacy scope index", duplicateKeyIndexName(errB) === LEGACY_SCOPE_INDEX, `index=${duplicateKeyIndexName(errB)}`);
  check("B3 classified as legacy_reference", classifyDuplicateKey(errB) === "legacy_reference");

  // ---- C. SERVICE: happy path creates space+binding on real MySQL --------------
  console.log("  [C] persistSpaceIdentities happy path (real service)");
  const lmC = await seedLinkedModel(conn, "C");
  const mdC = await seedModel(conn, lmC);
  const vC = await seedVersion(conn, mdC);
  const eC = await seedEntity(conn);
  const outC = await persist(service, {
    linkedModelId: lmC, modelId: mdC, modelVersionId: vC,
    candidates: [candidate(GUID_A, "R-101", eC)],
  });
  check("C1 service created one persistent space", outC.diagnostics.created_spaces === 1 && await spacesCount(conn, lmC) === 1);
  const [cBind]: any = await conn.query("SELECT ifc_guid FROM space_bindings WHERE model_version_id = ?", [vC]);
  check("C2 binding written with canonical GlobalId (INSERT…SELECT byte equality)", cBind[0]?.ifc_guid === GUID_A);

  // ---- D. SERVICE: NEW GlobalId reusing another space's Reference → typed error -
  console.log("  [D] persistSpaceIdentities legacy Reference collision (real service, deterministic)");
  const lmD = await seedLinkedModel(conn, "D");
  const mdD = await seedModel(conn, lmD);
  const vD = await seedVersion(conn, mdD);
  const eD = await seedEntity(conn);
  await spaceDb.createSpace({ linkedModelId: lmD, ifcGlobalId: GUID_A, inventoryCode: "R-101", inventoryCodeNormalized: "R-101", name: "owner" });
  const errD = await captureError(() => persist(service, {
    linkedModelId: lmD, modelId: mdD, modelVersionId: vD, candidates: [candidate(GUID_B, "R-101", eD)],
  }));
  check("D1 service raised TransitionalReferenceCollisionError (not a raw dup, not Reference reuse)",
    errD instanceof service.TransitionalReferenceCollisionError, `err=${errD?.name}`);
  check("D2 no second space created", await spacesCount(conn, lmD) === 1);

  // ---- E. SERVICE: existing GlobalId Reference-change collision (real service) --
  console.log("  [E] persistSpaceIdentities existing-GlobalId Reference-change collision");
  const lmE = await seedLinkedModel(conn, "E");
  const mdE = await seedModel(conn, lmE);
  const vE = await seedVersion(conn, mdE);
  const eE = await seedEntity(conn);
  const spEa = await spaceDb.createSpace({ linkedModelId: lmE, ifcGlobalId: GUID_A, inventoryCode: "R-101", inventoryCodeNormalized: "R-101", name: "A" });
  const spEb = await spaceDb.createSpace({ linkedModelId: lmE, ifcGlobalId: GUID_B, inventoryCode: "R-102", inventoryCodeNormalized: "R-102", name: "B" });
  const errE = await captureError(() => persist(service, {
    linkedModelId: lmE, modelId: mdE, modelVersionId: vE, candidates: [candidate(GUID_A, "R-102", eE)],
  }));
  check("E1 service raised TransitionalReferenceCollisionError before any UPDATE", errE instanceof service.TransitionalReferenceCollisionError);
  check("E2 space A Reference unchanged (R-101)", (await spaceRowById(conn, spEa.spaceId)).inventory_code_normalized === "R-101");
  check("E3 space B Reference unchanged (R-102)", (await spaceRowById(conn, spEb.spaceId)).inventory_code_normalized === "R-102");

  // ---- F. SERVICE: existing GlobalId Reference-change SUCCESS records prior value
  console.log("  [F] persistSpaceIdentities Reference-change success + compensation journal");
  const lmF = await seedLinkedModel(conn, "F");
  const mdF = await seedModel(conn, lmF);
  const vF = await seedVersion(conn, mdF);
  const eF = await seedEntity(conn);
  const spF = await spaceDb.createSpace({ linkedModelId: lmF, ifcGlobalId: GUID_A, inventoryCode: "R-OLD", inventoryCodeNormalized: "R-OLD", name: "old" });
  const outF = await persist(service, {
    linkedModelId: lmF, modelId: mdF, modelVersionId: vF, candidates: [candidate(GUID_A, "R-NEW", eF)],
  });
  check("F1 Reference updated to R-NEW on the SAME space id", (await spaceRowById(conn, spF.spaceId)).inventory_code_normalized === "R-NEW");
  check("F2 outcome records the prior value + applied projection for compensation",
    outF.referenceUpdates.length === 1 && outF.referenceUpdates[0].previousInventoryCodeNormalized === "R-OLD"
    && outF.referenceUpdates[0].appliedInventoryCode === "R-NEW" && outF.referenceUpdates[0].appliedInventoryCodeNormalized === "R-NEW");
  // Compensating restore (conditional) puts R-OLD back.
  const restored = await spaceDb.restoreCurrentReference(outF.referenceUpdates[0]);
  check("F3 conditional restore reverts to R-OLD", restored === 1 && (await spaceRowById(conn, spF.spaceId)).inventory_code_normalized === "R-OLD");

  // ---- G. §6.A REAL uq_spaces_scope_code UPDATE RACE ---------------------------
  console.log("  [G] real uq_spaces_scope_code UPDATE race");
  const lmG = await seedLinkedModel(conn, "G");
  const spGa = await spaceDb.createSpace({ linkedModelId: lmG, ifcGlobalId: GUID_A, inventoryCode: "R-101", inventoryCodeNormalized: "R-101", name: "A" });
  await spaceDb.createSpace({ linkedModelId: lmG, ifcGlobalId: GUID_B, inventoryCode: "R-102", inventoryCodeNormalized: "R-102", name: "B" });
  // Directly attempt to move space A's Reference onto R-102 (held by B) — the real
  // UPDATE raises ER_DUP_ENTRY on uq_spaces_scope_code (this is what the race would
  // surface between the pre-check and the UPDATE).
  const errG = await captureError(() => spaceDb.updateCurrentReference({ spaceId: spGa.spaceId, inventoryCode: "R-102", inventoryCodeNormalized: "R-102", name: "A" }));
  check("G1 real UPDATE raised a duplicate-key error", isDuplicateKeyError(errG));
  check("G2 index is uq_spaces_scope_code → translated to a transitional collision", classifyDuplicateKey(errG) === "legacy_reference");
  check("G3 space A Reference NOT partially updated (still R-101)", (await spaceRowById(conn, spGa.spaceId)).inventory_code_normalized === "R-101");

  // ---- H. §4/§5 ATOMIC BINDING / CANONICAL + CHAIN EQUALITY ---------------------
  console.log("  [H] atomic binding/canonical + model-version/linked-model chain (createBinding)");
  const lmH = await seedLinkedModel(conn, "H");
  const mdH = await seedModel(conn, lmH);
  const vH = await seedVersion(conn, mdH);
  const spH = await spaceDb.createSpace({ linkedModelId: lmH, ifcGlobalId: GUID_A, inventoryCode: "R-101", inventoryCodeNormalized: "R-101", name: "H" });
  // A. matching space/GlobalId/model-version chain creates exactly one binding.
  const eH1 = await seedEntity(conn);
  const bId = await spaceDb.createBinding({ spaceId: spH.spaceId, modelVersionId: vH, entityId: eH1, ifcGuid: GUID_A, inventoryCodeSnapshot: "R-101", nameSnapshot: "H" });
  check("H-A matching space/GlobalId/model-version chain creates exactly one binding", Number(bId) > 0);
  // B. correct GlobalId but a model version from ANOTHER linked_model → chain mismatch.
  const lmHother = await seedLinkedModel(conn, "H-other");
  const vHother = await seedVersion(conn, await seedModel(conn, lmHother));
  const eH2 = await seedEntity(conn);
  const errHchain = await captureError(() => spaceDb.createBinding({ spaceId: spH.spaceId, modelVersionId: vHother, entityId: eH2, ifcGuid: GUID_A, inventoryCodeSnapshot: "R-101" }));
  check("H-B correct GlobalId but model version from another linked_model → canonical_inconsistency (chain mismatch)",
    errHchain?.code === "canonical_inconsistency" && errHchain?.diagnostics?.cause === "linked_model_chain_mismatch", `cause=${errHchain?.diagnostics?.cause}`);
  // C. missing model version → chain cannot be satisfied.
  const eH3 = await seedEntity(conn);
  const errHmv = await captureError(() => spaceDb.createBinding({ spaceId: spH.spaceId, modelVersionId: 8888888, entityId: eH3, ifcGuid: GUID_A, inventoryCodeSnapshot: "R-101" }));
  check("H-C missing model version → canonical_inconsistency (missing_model_version)",
    errHmv?.code === "canonical_inconsistency" && errHmv?.diagnostics?.cause === "missing_model_version", `cause=${errHmv?.diagnostics?.cause}`);
  // D. valid but DIFFERENT GlobalId (same chain) → canonical mismatch.
  const vH2 = await seedVersion(conn, mdH);
  const eH4 = await seedEntity(conn);
  const errHB = await captureError(() => spaceDb.createBinding({ spaceId: spH.spaceId, modelVersionId: vH2, entityId: eH4, ifcGuid: GUID_B, inventoryCodeSnapshot: "R-101" }));
  check("H-D different GlobalId → canonical_inconsistency (canonical_globalid_mismatch)",
    errHB?.code === "canonical_inconsistency" && errHB?.diagnostics?.cause === "canonical_globalid_mismatch", `cause=${errHB?.diagnostics?.cause}`);
  // D'. case-different GlobalId rejected as a mismatch (ascii_bin).
  const eH5 = await seedEntity(conn);
  const lmHc = await seedLinkedModel(conn, "Hc");
  const spHc = await spaceDb.createSpace({ linkedModelId: lmHc, ifcGlobalId: GUID_CASE_LOWER, inventoryCode: "R-1", inventoryCodeNormalized: "R-1", name: "hc" });
  const vHc = await seedVersion(conn, await seedModel(conn, lmHc));
  const errHC = await captureError(() => spaceDb.createBinding({ spaceId: spHc.spaceId, modelVersionId: vHc, entityId: eH5, ifcGuid: GUID_CASE_UPPER, inventoryCodeSnapshot: "R-1" }));
  check("H-D' case-different GlobalId rejected as a mismatch", errHC?.code === "canonical_inconsistency");
  // D''. nonexistent spaceId → zero rows.
  const eH6 = await seedEntity(conn);
  const errHD = await captureError(() => spaceDb.createBinding({ spaceId: 9999999, modelVersionId: vH, entityId: eH6, ifcGuid: GUID_A, inventoryCodeSnapshot: "R-101" }));
  check("H-D'' nonexistent spaceId → canonical_inconsistency (missing_space)",
    errHD?.code === "canonical_inconsistency" && errHD?.diagnostics?.cause === "missing_space", `cause=${errHD?.diagnostics?.cause}`);
  // E. no historical binding altered after any rejected attempt.
  const [histCount]: any = await conn.query("SELECT COUNT(*) AS c FROM space_bindings WHERE space_id = ?", [spH.spaceId]);
  check("H-E historical binding preserved (exactly one, unchanged)", Number(histCount[0].c) === 1);

  // ---- I. CASE-DIFFERENT GLOBALIDS distinct ------------------------------------
  console.log("  [I] case-different GlobalIds accepted as distinct");
  const lmI = await seedLinkedModel(conn, "I");
  const spI1 = await spaceDb.createSpace({ linkedModelId: lmI, ifcGlobalId: GUID_CASE_LOWER, inventoryCode: "R-1", inventoryCodeNormalized: "R-1", name: "l" });
  const spI2 = await spaceDb.createSpace({ linkedModelId: lmI, ifcGlobalId: GUID_CASE_UPPER, inventoryCode: "R-2", inventoryCodeNormalized: "R-2", name: "u" });
  check("I1 two distinct spaces for case-different GlobalIds", Number(spI1.spaceId) !== Number(spI2.spaceId) && await spacesCount(conn, lmI) === 2);

  // ---- J. INVALID GLOBALID rejected before INSERT; DB CHECK as final defence ----
  console.log("  [J] invalid GlobalId rejected by application preflight before INSERT");
  const lmJ = await seedLinkedModel(conn, "J");
  for (const bad of [null, "", "   ", ` ${GUID_A} `, GUID_A.slice(0, 21), `${GUID_A}X`, `${GUID_A.slice(0, 21)}!`] as any[]) {
    check(`J validator rejects ${JSON.stringify(bad)}`, !isValidIfcGlobalId(bad));
    const e = await captureError(() => spaceDb.createSpace({ linkedModelId: lmJ, ifcGlobalId: bad, inventoryCode: "R-9", inventoryCodeNormalized: "R-9", name: "x" }));
    check(`J createSpace throws before INSERT for ${JSON.stringify(bad)}`, e !== null && !isDuplicateKeyError(e));
  }
  check("J zero rows written for any invalid candidate", await spacesCount(conn, lmJ) === 0);
  const rawErr = await captureError(() => conn.query(
    "INSERT INTO spaces (space_uuid, ifc_global_id, inventory_code, inventory_code_normalized, linked_model_id, name, status) VALUES (?, ?, 'R-9', 'R-9', ?, 'x', 'active')",
    [crypto.randomUUID(), "not-a-valid-guid!!!!!!", lmJ]));
  check("J DB CHECK rejects a raw invalid ifc_global_id (defence in depth)", rawErr !== null);

  // ---- K. BINDING/CANONICAL MISMATCH read-side integrity blocks -----------------
  console.log("  [K] pre-existing binding/canonical mismatch blocks without repair");
  const lmK = await seedLinkedModel(conn, "K");
  const vK = await seedVersion(conn, await seedModel(conn, lmK));
  const spK = await spaceDb.createSpace({ linkedModelId: lmK, ifcGlobalId: GUID_A, inventoryCode: "R-101", inventoryCodeNormalized: "R-101", name: "K" });
  const eK = await seedEntity(conn);
  // Raw insert to SIMULATE pre-existing corruption (createBinding itself refuses it).
  await conn.query("INSERT INTO space_bindings (space_id, model_version_id, entity_id, ifc_guid, inventory_code_snapshot) VALUES (?, ?, ?, ?, 'R-101')", [spK.spaceId, vK, eK, GUID_B]);
  const inc = await spaceDb.findScopeCanonicalInconsistencies(lmK);
  check("K1 mismatch detected (byte-exact)", inc.bindingMismatch.length === 1);
  const [kGuid]: any = await conn.query("SELECT ifc_guid FROM space_bindings WHERE space_id = ?", [spK.spaceId]);
  check("K2 no repair performed", kGuid[0].ifc_guid === GUID_B);

  // ---- L. COMPENSATION removes only orphan spaces ------------------------------
  console.log("  [L] compensation removes only orphan spaces");
  const lmL = await seedLinkedModel(conn, "L");
  const vL = await seedVersion(conn, await seedModel(conn, lmL));
  const spOrphan = await spaceDb.createSpace({ linkedModelId: lmL, ifcGlobalId: GUID_A, inventoryCode: "R-101", inventoryCodeNormalized: "R-101", name: "orphan" });
  const spBound = await spaceDb.createSpace({ linkedModelId: lmL, ifcGlobalId: GUID_B, inventoryCode: "R-102", inventoryCodeNormalized: "R-102", name: "bound" });
  const eL = await seedEntity(conn);
  await spaceDb.createBinding({ spaceId: spBound.spaceId, modelVersionId: vL, entityId: eL, ifcGuid: GUID_B, inventoryCodeSnapshot: "R-102" });
  await spaceDb.deleteSpacesWithoutBindings([spOrphan.spaceId, spBound.spaceId]);
  check("L1 orphan (no binding) removed", (await spaceRowById(conn, spOrphan.spaceId)) === undefined);
  check("L2 bound space preserved", (await spaceRowById(conn, spBound.spaceId)) !== undefined);

  // ---- M. §7-v3 FAITHFUL TWO-CONNECTION UPDATE RACE via the ACTUAL SERVICE -------
  console.log("  [M] faithful two-connection uq_spaces_scope_code UPDATE race via the SERVICE");
  const lmM = await seedLinkedModel(conn, "M");
  const mdM = await seedModel(conn, lmM);
  const vM = await seedVersion(conn, mdM);
  const eM = await seedEntity(conn);
  const spMa = await spaceDb.createSpace({ linkedModelId: lmM, ifcGlobalId: GUID_A, inventoryCode: "R-OLD", inventoryCodeNormalized: "R-OLD", name: "A" });
  // R-TAKEN is initially FREE. The service performs its REAL pre-check (observes free),
  // then the barrier hook fires: a SECOND real connection (conn2) assigns R-TAKEN to a
  // different space. Only THEN does the service's real UPDATE run and hit the real
  // uq_spaces_scope_code — the ACTUAL service catch translates it. This is a genuine
  // two-connection race, not a monkeypatched stale read.
  let hookFired = false;
  service.__setAfterReferencePrecheckHook(async () => {
    service.__setAfterReferencePrecheckHook(undefined); // fire exactly once
    hookFired = true;
    await conn2.query(
      "INSERT INTO spaces (space_uuid, ifc_global_id, inventory_code, inventory_code_normalized, linked_model_id, name, status) VALUES (?, ?, 'R-TAKEN', 'R-TAKEN', ?, 'B', 'active')",
      [crypto.randomUUID(), GUID_B, lmM]);
  });
  const errM = await captureError(() => persist(service, {
    linkedModelId: lmM, modelId: mdM, modelVersionId: vM, candidates: [candidate(GUID_A, "R-TAKEN", eM)],
  }));
  service.__setAfterReferencePrecheckHook(undefined);
  check("M0 barrier hook fired after the real pre-check, before the real UPDATE", hookFired);
  check("M1 service returned TransitionalReferenceCollisionError from the UPDATE catch", errM instanceof service.TransitionalReferenceCollisionError, `err=${errM?.name}`);
  check("M2 marked concurrent (raced between pre-check and UPDATE)", errM?.diagnostics?.concurrent === true);
  check("M3 raw ER_DUP_ENTRY not exposed (translated, not leaked)", !isDuplicateKeyError(errM));
  check("M4 space A Reference NOT partially updated (still R-OLD)", (await spaceRowById(conn, spMa.spaceId)).inventory_code_normalized === "R-OLD");
  const [mBind]: any = await conn.query("SELECT COUNT(*) AS c FROM space_bindings WHERE model_version_id = ?", [vM]);
  check("M5 no binding or reconciliation write followed the collision", Number(mBind[0].c) === 0);

  // ---- N. §6 LINKED_MODEL REFERENCE LOCK: deterministic independence/serialization -
  console.log("  [N] linked_model Reference lock (deterministic entered/release barriers)");
  const lmN1 = await seedLinkedModel(conn, "N1");
  const lmN2 = await seedLinkedModel(conn, "N2");
  // Independence: while lmN1's lock is held, a DIFFERENT linked_model acquires freely.
  const gate1 = deferred();
  const enteredN1 = deferred();
  const order: string[] = [];
  const held1 = spaceDb.withReferenceLock(lmN1, async () => { order.push("N1-enter"); enteredN1.resolve(); await gate1.promise; order.push("N1-exit"); });
  await enteredN1.promise; // deterministic: N1 has entered and holds the lock
  await spaceDb.withReferenceLock(lmN2, async () => { order.push("N2-ran"); });
  check("N1 different linked_models proceed independently (N2 ran while N1 held)", order.includes("N2-ran") && !order.includes("N1-exit"));
  gate1.resolve();
  await held1;
  // Serialization: same linked_model — the second waiter cannot enter until the first
  // releases (this is the window that stops the previous Reference being reclaimed).
  const gate2 = deferred();
  const enteredA = deferred();
  const enteredB = deferred();
  const order2: string[] = [];
  const lockA = spaceDb.withReferenceLock(lmN1, async () => { order2.push("A-enter"); enteredA.resolve(); await gate2.promise; order2.push("A-exit"); });
  await enteredA.promise; // deterministic: A entered
  let bEntered = false;
  const lockB = spaceDb.withReferenceLock(lmN1, async () => { bEntered = true; order2.push("B-enter"); enteredB.resolve(); });
  // Prove B is blocked: its entry must NOT win a bounded race while A still holds.
  const blockedRace = await Promise.race([enteredB.promise.then(() => "B-entered"), sleep(150).then(() => "still-blocked")]);
  check("N2 same linked_model serialises (B blocked while A holds)", blockedRace === "still-blocked" && bEntered === false);
  gate2.resolve();
  await Promise.all([lockA, lockB]);
  await enteredB.promise;
  check("N3 serialised order preserved (A completes before B enters)", order2.join(",") === "A-enter,A-exit,B-enter");
  // Cleanup: after release the lock is free — a fresh acquire returns immediately.
  let acquiredAgain = false;
  await spaceDb.withReferenceLock(lmN1, async () => { acquiredAgain = true; });
  check("N4 lock released in finally (re-acquire succeeds)", acquiredAgain);

  // ---- N'. §4-v3 DATABASE-SCOPED LOCK NAME ------------------------------------
  console.log("  [N'] advisory-lock name is scoped to the ACTUAL database");
  const nameThisDbLm = service.referenceLockName(schema, 777);
  const nameOtherDbLm = service.referenceLockName("some_other_schema_name", 777);
  const nameSameAgain = service.referenceLockName(schema, 777);
  check("N'1 same db + same linked_model → identical name", nameThisDbLm === nameSameAgain);
  check("N'2 different db + same linked_model id → DIFFERENT name (no cross-schema contention)", nameThisDbLm !== nameOtherDbLm);
  check("N'3 lock name within MySQL's 64-char limit", nameThisDbLm.length <= 64, `len=${nameThisDbLm.length}`);
  // Real proof: while this schema holds withReferenceLock(777), a raw connection can
  // acquire the SAME linked_model id under a DIFFERENT database's name, but NOT under
  // this database's name.
  const gateNp = deferred();
  const enteredNp = deferred();
  const heldNp = spaceDb.withReferenceLock(777, async () => { enteredNp.resolve(); await gateNp.promise; });
  await enteredNp.promise;
  const [otherDbAcq]: any = await conn2.query("SELECT GET_LOCK(?, 0) AS a", [service.referenceLockName("some_other_schema_name", 777)]);
  check("N'4 different-schema same-lm-id lock acquires immediately (independent)", Number(otherDbAcq[0].a) === 1);
  await conn2.query("SELECT RELEASE_LOCK(?)", [service.referenceLockName("some_other_schema_name", 777)]);
  const [sameDbAcq]: any = await conn2.query("SELECT GET_LOCK(?, 0) AS a", [service.referenceLockName(schema, 777)]);
  check("N'5 same-schema same-lm-id lock is contended (does not acquire)", Number(sameDbAcq[0].a) === 0);
  gateNp.resolve();
  await heldNp;

  // ---- O. §6 COMPARE-AND-SWAP restore (full projection) -------------------------
  console.log("  [O] conditional compensation restore is a FULL-projection compare-and-swap");
  const lmO = await seedLinkedModel(conn, "O");
  const spO = await spaceDb.createSpace({ linkedModelId: lmO, ifcGlobalId: GUID_A, inventoryCode: "R-OLD", inventoryCodeNormalized: "R-OLD", name: "O-old" });
  // This operation applied the full projection {raw:R-NEW, norm:R-NEW, name:O-new}.
  await spaceDb.updateCurrentReference({ spaceId: spO.spaceId, inventoryCode: "R-NEW", inventoryCodeNormalized: "R-NEW", name: "O-new" });
  const journalO = { spaceId: spO.spaceId, appliedInventoryCode: "R-NEW", appliedInventoryCodeNormalized: "R-NEW", appliedName: "O-new",
    previousInventoryCode: "R-OLD", previousInventoryCodeNormalized: "R-OLD", previousName: "O-old" };
  // O-a: a newer change to the NAME ONLY (same normalized Reference) must NOT be clobbered.
  await spaceDb.updateCurrentReference({ spaceId: spO.spaceId, inventoryCode: "R-NEW", inventoryCodeNormalized: "R-NEW", name: "O-renamed" });
  const restoredNameChanged = await spaceDb.restoreCurrentReference(journalO);
  check("O1 restore matched 0 rows when NAME changed under the same normalized Reference", restoredNameChanged === 0);
  check("O2 newer Name preserved (O-renamed, not reverted)", (await spaceRowById(conn, spO.spaceId)).name === "O-renamed");
  // O-b: reset to the EXACT applied projection → restore now succeeds.
  await spaceDb.updateCurrentReference({ spaceId: spO.spaceId, inventoryCode: "R-NEW", inventoryCodeNormalized: "R-NEW", name: "O-new" });
  const restoredExact = await spaceDb.restoreCurrentReference(journalO);
  check("O3 restore succeeds when the FULL applied projection still matches", restoredExact === 1 && (await spaceRowById(conn, spO.spaceId)).inventory_code_normalized === "R-OLD");
  // O-c: a newer normalized-Reference change is likewise never overwritten.
  await spaceDb.updateCurrentReference({ spaceId: spO.spaceId, inventoryCode: "R-NEWER", inventoryCodeNormalized: "R-NEWER", name: "O-new" });
  const restoredNormChanged = await spaceDb.restoreCurrentReference(journalO);
  check("O4 restore matched 0 rows when normalized Reference changed", restoredNormChanged === 0 && (await spaceRowById(conn, spO.spaceId)).inventory_code_normalized === "R-NEWER");

  // ---- O'. §4-v4 BYTE-EXACT restore under the case-insensitive table collation --
  console.log("  [O'] compare-and-swap restore is BYTE-EXACT (case/accent-only newer values are not overwritten)");
  const lmOp = await seedLinkedModel(conn, "Oprime");
  const spOp = await spaceDb.createSpace({ linkedModelId: lmOp, ifcGlobalId: GUID_A, inventoryCode: "R-OLD", inventoryCodeNormalized: "R-OLD", name: "Prev" });
  // The applied projection this operation journaled: {raw:R-CASE, norm:R-CASE, name:Cafe}.
  const journalOp = { spaceId: spOp.spaceId, appliedInventoryCode: "R-CASE", appliedInventoryCodeNormalized: "R-CASE", appliedName: "Cafe",
    previousInventoryCode: "R-OLD", previousInventoryCodeNormalized: "R-OLD", previousName: "Prev" };
  const setOp = (inventoryCode: string, inventoryCodeNormalized: string, name: string) =>
    spaceDb.updateCurrentReference({ spaceId: spOp.spaceId, inventoryCode, inventoryCodeNormalized, name });
  // (a) case-only RAW Reference change (r-case vs R-CASE): equal under the ci collation,
  // DIFFERENT byte-for-byte → restore must NOT fire.
  await setOp("r-case", "R-CASE", "Cafe");
  check("O'1 case-only raw Reference change prevents restoration (0 rows)", (await spaceDb.restoreCurrentReference(journalOp)) === 0);
  // (b) case-only NORMALIZED Reference change.
  await setOp("R-CASE", "r-case", "Cafe");
  check("O'2 case-only normalized Reference change prevents restoration (0 rows)", (await spaceDb.restoreCurrentReference(journalOp)) === 0);
  // (c) case-only NAME change (Cafe vs cafe).
  await setOp("R-CASE", "R-CASE", "cafe");
  check("O'3 case-only Name change prevents restoration (0 rows)", (await spaceDb.restoreCurrentReference(journalOp)) === 0);
  // (d) accent-only NAME change (Cafe vs Café): equal under the ai collation, different bytes.
  await setOp("R-CASE", "R-CASE", "Café");
  check("O'4 accent-only Name change prevents restoration (0 rows)", (await spaceDb.restoreCurrentReference(journalOp)) === 0);
  // (e) EXACT complete match restores successfully → reverts to the previous projection.
  await setOp("R-CASE", "R-CASE", "Cafe");
  const okOp = await spaceDb.restoreCurrentReference(journalOp);
  const rowOp = await spaceRowById(conn, spOp.spaceId);
  check("O'5 exact complete match restores (1 row) and reverts raw+normalized+name",
    okOp === 1 && rowOp.inventory_code === "R-OLD" && rowOp.inventory_code_normalized === "R-OLD" && rowOp.name === "Prev");
  // (f) NULL-safe Name: applied name NULL, a newer non-NULL name blocks; exact NULL restores.
  const lmOpn = await seedLinkedModel(conn, "OprimeN");
  const spOpn = await spaceDb.createSpace({ linkedModelId: lmOpn, ifcGlobalId: GUID_A, inventoryCode: "R-N", inventoryCodeNormalized: "R-N", name: null });
  const journalOpn = { spaceId: spOpn.spaceId, appliedInventoryCode: "R-N2", appliedInventoryCodeNormalized: "R-N2", appliedName: null,
    previousInventoryCode: "R-N", previousInventoryCodeNormalized: "R-N", previousName: null };
  await spaceDb.updateCurrentReference({ spaceId: spOpn.spaceId, inventoryCode: "R-N2", inventoryCodeNormalized: "R-N2", name: "now-named" });
  check("O'6 NULL applied Name vs newer non-NULL Name prevents restoration (0 rows)", (await spaceDb.restoreCurrentReference(journalOpn)) === 0);
  await spaceDb.updateCurrentReference({ spaceId: spOpn.spaceId, inventoryCode: "R-N2", inventoryCodeNormalized: "R-N2", name: null });
  check("O'7 NULL applied Name matches NULL exactly and restores (1 row)", (await spaceDb.restoreCurrentReference(journalOpn)) === 1);

  // ---- P. §7-v3 COMBINED lock-held-through-compensation window -------------------
  console.log("  [P] the previous Reference cannot be claimed during the compensation window");
  const lmP = await seedLinkedModel(conn, "P");
  const spPa = await spaceDb.createSpace({ linkedModelId: lmP, ifcGlobalId: GUID_A, inventoryCode: "R-OLD", inventoryCodeNormalized: "R-OLD", name: "PA" });
  const gatePfail = deferred();
  const enteredP = deferred();
  const journalP = { spaceId: spPa.spaceId, appliedInventoryCode: "R-NEW", appliedInventoryCodeNormalized: "R-NEW", appliedName: "PA",
    previousInventoryCode: "R-OLD", previousInventoryCodeNormalized: "R-OLD", previousName: "PA" };
  // Operation A: hold the lock, change R-OLD→R-NEW, then (on signal) compensate back to
  // R-OLD, all while holding the lock.
  const opA = spaceDb.withReferenceLock(lmP, async () => {
    await spaceDb.updateCurrentReference({ spaceId: spPa.spaceId, inventoryCode: "R-NEW", inventoryCodeNormalized: "R-NEW", name: "PA" });
    enteredP.resolve();
    await gatePfail.promise;      // simulate work up to the later failure
    await spaceDb.restoreCurrentReference(journalP); // compensation restores R-OLD, lock still held
  });
  await enteredP.promise;
  // Operation B (a cooperating op) tries to CLAIM R-OLD for a different space; it must
  // block on the lock until A completes its compensation and releases.
  let bClash: any;
  let bAcquired = false;
  const opB = spaceDb.withReferenceLock(lmP, async () => {
    bAcquired = true; // only reached after acquiring the lock, i.e. after A released
    bClash = await spaceDb.findByScopeAndCode(lmP, "R-OLD");
  });
  const bRace = await Promise.race([opB.then(() => "B-done"), sleep(150).then(() => "B-blocked")]);
  check("P1 B is blocked during A's compensation window (never acquired while A held)", bRace === "B-blocked" && bAcquired === false);
  gatePfail.resolve();
  await opA;
  await opB;
  check("P2 after A restored R-OLD and released, B observes the collision (R-OLD taken by A)", bClash && Number(bClash.id) === Number(spPa.spaceId));
  check("P3 A's space still holds the restored R-OLD (compensation completed under the lock)", (await spaceRowById(conn, spPa.spaceId)).inventory_code_normalized === "R-OLD");
}

/**
 * §8-v4 GENUINE two-schema database-scoped lock test. Two REAL MySQLDatabase instances
 * are bound to two ACTUALLY-DIFFERENT selected schemas; the REAL name factory
 * (referenceLockNameFactory) runs `SELECT DATABASE()` on each instance's own dedicated
 * connection. This proves the same linked_model id does NOT contend across schemas
 * (independent namespaces) and DOES contend within one schema — NOT by passing two
 * arbitrary schema-name strings to referenceLockName while both connections sit on the
 * same schema. `rawConnA` is a raw connection used only to probe held/free names.
 */
async function runTwoSchemaLockTest(
  dbA: any, dbB: any, schemaA: string, schemaB: string,
  referenceLockName: (db: string, lm: number) => string,
  referenceLockNameFactory: (lm: number) => (conn: any) => Promise<string>,
  rawConnA: mysql.Connection,
): Promise<void> {
  console.log("  [T] genuine two-schema database-scoped lock (two really-selected schemas)");
  const lm = 4242;
  const [ra]: any = await dbA.connection.query("SELECT DATABASE() AS db");
  const [rb]: any = await dbB.connection.query("SELECT DATABASE() AS db");
  check("T1 dbA connection is genuinely selected on schema A", ra[0].db === schemaA, `db=${ra[0].db}`);
  check("T2 dbB connection is genuinely selected on schema B", rb[0].db === schemaB, `db=${rb[0].db}`);
  check("T3 the two disposable schemas are different", schemaA !== schemaB);

  const factory = referenceLockNameFactory(lm);
  const gate = deferred();
  const entered = deferred();
  // A holds the REAL database-scoped lock (name derived on A's own connection).
  const held = dbA.withNamedLock(factory, 30, async () => { entered.resolve(); await gate.promise; });
  await entered.promise;
  // (a) same linked_model id, schema B: INDEPENDENT → dbB acquires immediately via the
  // same real helper deriving the name on B's own connection.
  let bAcquired = false;
  await dbB.withNamedLock(factory, 0, async () => { bAcquired = true; });
  check("T4 same linked_model id does NOT contend across schema A and B (real helper on each)", bAcquired);
  // (b) the name A actually holds is the schema-A-derived name → a raw connection cannot
  // acquire it: proves the helper scoped the lock to A's ACTUAL selected schema.
  const [aContend]: any = await rawConnA.query("SELECT GET_LOCK(?, 0) AS a", [referenceLockName(schemaA, lm)]);
  check("T5 same schema + same linked_model DOES contend (schema-A name is held by A)", Number(aContend[0].a) === 0);
  // (c) the schema-B-derived name is a DIFFERENT lock, free while A holds schema-A's name.
  const [bFree]: any = await rawConnA.query("SELECT GET_LOCK(?, 0) AS a", [referenceLockName(schemaB, lm)]);
  check("T6 schema-B name is free while schema-A name is held (independent namespaces)", Number(bFree[0].a) === 1);
  await rawConnA.query("SELECT RELEASE_LOCK(?)", [referenceLockName(schemaB, lm)]);
  gate.resolve();
  await held;
  check("T7 schema-A lock released after A completes (re-acquirable)", true);
}

async function main() {
  const operationalDb = process.env.DB_NAME;
  const schema = `oswadt_spaceguid_rtmtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const schemaB = `${schema}_b`;
  if (schema === operationalDb || schemaB === operationalDb) throw new Error("refusing to reuse the operational database name");

  const baseConfig = {
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, multipleStatements: false,
  } as any;

  const server = await mysql.createConnection(baseConfig);
  let schemaCreated = false;
  let schemaBCreated = false;
  let schemaDropped = false;
  let schemaBDropped = false;
  let spaceDatabasePoolClosed = false;
  let disposableConnectionClosed = false;
  let serverConnectionClosed = false;
  let conn: mysql.Connection | undefined;
  let conn2: mysql.Connection | undefined;
  let spaceDb: any;
  let dbA: any;
  let dbB: any;
  let primaryError: unknown;
  // Cleanup errors are tracked SEPARATELY (§8) so one failure never blocks another
  // and none is silently swallowed.
  let poolCloseError: unknown;
  let disposableConnectionCloseError: unknown;
  let secondConnectionCloseError: unknown;
  let schemaDropError: unknown;
  let schemaBDropError: unknown;
  let dbAPoolCloseError: unknown;
  let dbBPoolCloseError: unknown;
  let serverConnectionCloseError: unknown;
  let secondConnectionClosed = false;
  let dbAPoolClosed = false;
  let dbBPoolClosed = false;

  try {
    console.log(JSON.stringify({ event: "space_globalid_runtime_self_test_start", disposableSchema: schema, disposableSchemaB: schemaB, operationalDatabase: operationalDb, note: "operational database is never selected or modified" }));
    await server.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    schemaCreated = true;
    // A SECOND disposable schema for the genuine two-schema database-scoped lock test (§8-v4).
    await server.query(`CREATE DATABASE \`${schemaB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    schemaBCreated = true;
    conn = await mysql.createConnection({ ...baseConfig, database: schema } as any);
    // Second real connection to the SAME disposable schema — the faithful two-connection
    // race barrier (§7-v3) and the cross-schema lock proofs (§4-v3) use it.
    conn2 = await mysql.createConnection({ ...baseConfig, database: schema } as any);

    // Repoint the singleton at the disposable schema BEFORE importing it.
    process.env.DB_NAME = schema;
    spaceDb = (await import("../utils/spaceDatabase.ts")).default;
    const service = await import("../services/spaceIdentityService.ts");
    const identityProvider = await import("../identity/spaceIdentityProvider.ts");
    const { referenceLockName, referenceLockNameFactory } = await import("../utils/spaceDatabase.ts");
    const { default: MySQLDatabase } = await import("../utils/mysqlDatabase.ts");
    const [facadeDb]: any = await spaceDb["db"].connection.execute("SELECT DATABASE() AS db", {});
    check("Stage 0B singleton is bound to the disposable schema", facadeDb[0].db === schema && facadeDb[0].db !== operationalDb, `db=${facadeDb[0].db}`);

    await runCases(conn, conn2, spaceDb, {
      persistSpaceIdentities: service.persistSpaceIdentities,
      TransitionalReferenceCollisionError: service.TransitionalReferenceCollisionError,
      setSpaceIdentityResolver: identityProvider.setSpaceIdentityResolver,
      __setAfterReferencePrecheckHook: service.__setAfterReferencePrecheckHook,
      referenceLockName,
    }, operationalDb, schema);

    // §8-v4: two REAL MySQLDatabase instances bound to two genuinely-different selected
    // schemas, driving the REAL referenceLockNameFactory on each.
    process.env.DB_NAME = schema;   dbA = new MySQLDatabase(); await dbA.connect();
    process.env.DB_NAME = schemaB;  dbB = new MySQLDatabase(); await dbB.connect();
    process.env.DB_NAME = schema;   // restore for any later singleton use
    await runTwoSchemaLockTest(dbA, dbB, schema, schemaB, referenceLockName, referenceLockNameFactory, conn2);
  } catch (e) {
    primaryError = e;
  } finally {
    // Restore the original DB_NAME even though the script is normally standalone (§8).
    if (operationalDb === undefined) delete process.env.DB_NAME; else process.env.DB_NAME = operationalDb;

    // Attempt EVERY cleanup step independently; track each outcome.
    if (spaceDb) {
      try { await spaceDb["db"].disconnect(); spaceDatabasePoolClosed = true; }
      catch (e) { poolCloseError = e; console.error(`cleanup: failed closing singleton pool: ${String((e as any)?.message ?? e)}`); }
    } else {
      spaceDatabasePoolClosed = true; // nothing to close
    }
    if (dbA) {
      try { await dbA.disconnect(); dbAPoolClosed = true; }
      catch (e) { dbAPoolCloseError = e; console.error(`cleanup: failed closing dbA pool: ${String((e as any)?.message ?? e)}`); }
    } else { dbAPoolClosed = true; }
    if (dbB) {
      try { await dbB.disconnect(); dbBPoolClosed = true; }
      catch (e) { dbBPoolCloseError = e; console.error(`cleanup: failed closing dbB pool: ${String((e as any)?.message ?? e)}`); }
    } else { dbBPoolClosed = true; }
    if (conn) {
      try { await conn.end(); disposableConnectionClosed = true; }
      catch (e) { disposableConnectionCloseError = e; console.error(`cleanup: failed closing disposable connection: ${String((e as any)?.message ?? e)}`); }
    } else {
      disposableConnectionClosed = true;
    }
    if (conn2) {
      try { await conn2.end(); secondConnectionClosed = true; }
      catch (e) { secondConnectionCloseError = e; console.error(`cleanup: failed closing second disposable connection: ${String((e as any)?.message ?? e)}`); }
    } else {
      secondConnectionClosed = true;
    }
    if (schemaCreated) {
      try { await server.query(`DROP DATABASE \`${schema}\``); schemaDropped = true; }
      catch (e) { schemaDropError = e; console.error(`cleanup: FAILED to drop disposable schema '${schema}'. Manual cleanup required: DROP DATABASE \`${schema}\`; -- ${String((e as any)?.message ?? e)}`); }
    }
    if (schemaBCreated) {
      try { await server.query(`DROP DATABASE \`${schemaB}\``); schemaBDropped = true; }
      catch (e) { schemaBDropError = e; console.error(`cleanup: FAILED to drop disposable schema '${schemaB}'. Manual cleanup required: DROP DATABASE \`${schemaB}\`; -- ${String((e as any)?.message ?? e)}`); }
    }
    try { await server.end(); serverConnectionClosed = true; }
    catch (e) { serverConnectionCloseError = e; console.error(`cleanup: failed closing server connection: ${String((e as any)?.message ?? e)}`); }
  }

  const cleanupErrors = [poolCloseError, dbAPoolCloseError, dbBPoolCloseError, disposableConnectionCloseError, secondConnectionCloseError, schemaDropError, schemaBDropError, serverConnectionCloseError].filter((e) => e !== undefined);
  const primaryErrorPresent = primaryError !== undefined || failures > 0;
  const outcome = classifyOutcome({ primaryErrorPresent, cleanupErrorCount: cleanupErrors.length });

  console.log(JSON.stringify({
    event: "space_globalid_runtime_self_test_end",
    disposableSchema: schema, disposableSchemaB: schemaB, schemaCreated, schemaBCreated, schemaDropped, schemaBDropped,
    spaceDatabasePoolClosed, dbAPoolClosed, dbBPoolClosed, disposableConnectionClosed, secondConnectionClosed, serverConnectionClosed,
    primaryErrorPresent, cleanupErrorCount: cleanupErrors.length, passes, failures,
  }));

  if (primaryError !== undefined) console.error(`primary error: ${String((primaryError as any)?.message ?? primaryError)}`);
  if (failures > 0) console.error(`assertion failures: ${failures}`);
  if (schemaCreated && !schemaDropped) console.error(`DISPOSABLE SCHEMA NOT DROPPED — run manually: DROP DATABASE \`${schema}\`;`);
  if (schemaBCreated && !schemaBDropped) console.error(`DISPOSABLE SCHEMA NOT DROPPED — run manually: DROP DATABASE \`${schemaB}\`;`);

  console.log(`\n  ${passes} checks passed, ${failures} failed. outcome=${outcome.failureReason}`);
  if (!outcome.success) process.exit(1);
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
