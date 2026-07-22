import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ApplicationIdentityDatabase } from "../../applicationIdentity/applicationIdentityDatabase.ts";

class IdentityDatabaseHarness {
  calls: string[] = [];
  constructor(private readonly activeManager: boolean) {}
  async connect() {}
  async checkConnection() {}
  connection = { execute: async (sql: string) => {
    this.calls.push(sql);
    return [this.activeManager ? [{ present: 1 }] : []];
  } };
}

test("application area is resolved from an active server-side manager role, not an asset scope", async () => {
  const zeroScopes = new IdentityDatabaseHarness(true);
  assert.equal(await new ApplicationIdentityDatabase(zeroScopes as any).applicationArea(101), "manager");
  const withScopes = new IdentityDatabaseHarness(true);
  assert.equal(await new ApplicationIdentityDatabase(withScopes as any).applicationArea(102), "manager");
  const revokedManager = new IdentityDatabaseHarness(false);
  assert.equal(await new ApplicationIdentityDatabase(revokedManager as any).applicationArea(103), "student");
  const student = new IdentityDatabaseHarness(false);
  assert.equal(await new ApplicationIdentityDatabase(student as any).applicationArea(104), "student");
  const sql = zeroScopes.calls[0]!;
  assert.match(sql, /application_account_roles/); assert.match(sql, /normalized_role_key='reservation_manager'/); assert.match(sql, /a\.status='active'/);
  assert.doesNotMatch(sql, /reservation_management_scopes/);
});

test("the browser cannot choose an application role and the server returns the resolved area", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const auth = fs.readFileSync(path.join(root, "routes/applicationAuth.ts"), "utf8");
  const middleware = fs.readFileSync(path.join(root, "applicationIdentity/applicationIdentityMiddleware.ts"), "utf8");
  assert.match(auth, /provider\.createLocalSession\(String\(req\.body\?\.accountKey/);
  assert.doesNotMatch(auth, /req\.body\?\.applicationArea|req\.body\?\.role/);
  assert.match(auth, /applicationArea:area/); assert.match(middleware, /resolveRequestIdentity\(req\)/);
});
