import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ApplicationIdentityDatabase } from "../../applicationIdentity/applicationIdentityDatabase.ts";

// Harness returning one row per active role grant (LEFT JOIN shape), plus status
// and account_kind. It records the SQL so we can prove asset scopes are never
// consulted for capability derivation.
class CapabilityDb {
  lastSql = "";
  constructor(private readonly rows: any[]) {}
  async connect() {}
  async checkConnection() {}
  connection = { execute: async (sql: string) => { this.lastSql = sql; return [this.rows]; } };
}
function role(normalized_role_key: string | null, status = "active", account_kind = "human") {
  return { status, account_kind, normalized_role_key };
}
function caps(rows: any[]) { return new ApplicationIdentityDatabase(new CapabilityDb(rows) as any).resolveCapabilities(1); }

test("capability derivation: active human with no management role can only reserve resources", async () => {
  const a = await caps([role(null)]);
  assert.deepEqual(a.capabilities, { reserveResources: true, bimManagement: false, operationalManagement: false });
  assert.deepEqual(a.roles, []);
  assert.equal(a.applicationArea, "student");
});

test("capability derivation: bim_manager only grants bimManagement (never operationalManagement)", async () => {
  const a = await caps([role("bim_manager")]);
  assert.deepEqual(a.capabilities, { reserveResources: true, bimManagement: true, operationalManagement: false });
  assert.deepEqual(a.roles, ["bim_manager"]);
  assert.equal(a.applicationArea, "manager");
});

test("capability derivation: operational_manager only grants operationalManagement (never bimManagement)", async () => {
  const a = await caps([role("operational_manager")]);
  assert.deepEqual(a.capabilities, { reserveResources: true, bimManagement: false, operationalManagement: true });
  assert.deepEqual(a.roles, ["operational_manager"]);
  assert.equal(a.applicationArea, "manager");
});

test("capability derivation: both roles grant all three capabilities", async () => {
  const a = await caps([role("bim_manager"), role("operational_manager")]);
  assert.deepEqual(a.capabilities, { reserveResources: true, bimManagement: true, operationalManagement: true });
  assert.deepEqual([...a.roles].sort(), ["bim_manager", "operational_manager"]);
  assert.equal(a.applicationArea, "manager");
});

test("capability derivation: suspended or disabled accounts receive no active capability", async () => {
  for (const status of ["suspended", "disabled"]) {
    const a = await caps([role("operational_manager", status), role("bim_manager", status)]);
    assert.deepEqual(a.capabilities, { reserveResources: false, bimManagement: false, operationalManagement: false });
    assert.deepEqual(a.roles, []);
    assert.equal(a.applicationArea, "student");
  }
});

test("transition: a pre-migration reservation_manager grant resolves as canonical operationalManagement and is exposed as operational_manager", async () => {
  const a = await caps([role("reservation_manager")]);
  assert.equal(a.capabilities.operationalManagement, true);
  assert.deepEqual(a.roles, ["operational_manager"]);
  assert.doesNotMatch(JSON.stringify(a), /reservation_manager/);
});

test("capabilities are derived only from roles and account status, never from asset scopes", async () => {
  const db = new CapabilityDb([role(null)]);
  await new ApplicationIdentityDatabase(db as any).resolveCapabilities(9);
  assert.doesNotMatch(db.lastSql, /reservation_management_scopes/);
  // A student presence of scopes cannot grant management: derivation ignores scopes
  // entirely, so a no-role account is never operational or BIM.
  const scopedButNoRole = await caps([role(null)]);
  assert.equal(scopedButNoRole.capabilities.operationalManagement, false);
  assert.equal(scopedButNoRole.capabilities.bimManagement, false);
});

test("the session API exposes server-resolved capabilities and canonical roles, never a browser-chosen role", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const auth = fs.readFileSync(path.join(root, "routes/applicationAuth.ts"), "utf8");
  const middleware = fs.readFileSync(path.join(root, "applicationIdentity/applicationIdentityMiddleware.ts"), "utf8");
  assert.match(auth, /resolveCapabilities/);
  assert.match(auth, /capabilities:authorization\.capabilities/);
  assert.match(auth, /roles:authorization\.roles/);
  assert.doesNotMatch(auth, /req\.body\?\.applicationArea|req\.body\?\.role|req\.body\?\.capabilit/);
  assert.match(middleware, /resolveRequestIdentity\(req\)/);
});

test("route guards use explicit capabilities and never the applicationArea alias as the authority", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const intake = fs.readFileSync(path.join(root, "routes/modelIntake.ts"), "utf8");
  const manager = fs.readFileSync(path.join(root, "routes/managerReservations.ts"), "utf8");
  const asset = fs.readFileSync(path.join(root, "routes/asset.ts"), "utf8");
  const model = fs.readFileSync(path.join(root, "routes/model.ts"), "utf8");
  // BIM intake requires bimManagement; operational endpoints require operationalManagement.
  assert.match(intake, /requireBimManagement/);
  assert.match(manager, /operationalManagement/);
  assert.match(manager, /operational_management_required/);
  // Student/general reservation routes require reserveResources (managers included).
  assert.match(asset, /ensureReserveResources/);
  assert.match(model, /ensureReserveResources/);
  // applicationArea is not the authority for any of these guards.
  assert.doesNotMatch(intake, /applicationArea/);
  assert.doesNotMatch(manager, /applicationArea\(/);
});

test("capability lookups never leak as unhandled rejections: a failed lookup becomes a controlled 500", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const authorization = fs.readFileSync(path.join(root, "applicationIdentity/applicationAuthorization.ts"), "utf8");
  // resolveRequestCapabilities is wrapped so a database error yields a 500 body,
  // never a thrown/rejected promise from the middleware or inline guards.
  assert.match(authorization, /try \{\s*authorization = await resolveRequestCapabilities\(req\);/);
  assert.match(authorization, /authorization_unavailable/);
});

test("scope integrity: the operational service and forward migration never write reservation_management_scopes", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const stripSql = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  const stripTs = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  const service = stripTs(fs.readFileSync(path.join(root, "reservationApproval/reservationApprovalService.ts"), "utf8"));
  const migration = stripSql(fs.readFileSync(path.resolve(root, "../database/migrations/2026-07-27_manager_role_separation.sql"), "utf8"));
  // Excluding comments, neither the operational service code nor the forward
  // migration references the dormant scope table at all (no reads, no writes).
  assert.doesNotMatch(service, /reservation_management_scopes/);
  assert.doesNotMatch(migration, /reservation_management_scopes/);
});
