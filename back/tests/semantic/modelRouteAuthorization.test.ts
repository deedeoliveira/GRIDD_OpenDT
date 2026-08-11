/**
 * Authorization for the initial model-upload route and the internal model-version
 * download boundary (fix/model-upload-internal-download-auth).
 *
 *  A. POST /api/model/upload requires the bimManagement capability (requireBimManagement)
 *     BEFORE multer — unauthenticated and non-bim accounts are rejected; a bim_manager
 *     account is accepted.
 *  B. GET /api/model/versions/:versionId/download authorizes EITHER a valid internal-service
 *     token OR a reserveResources session, via the PRODUCTION function
 *     authorizeModelVersionDownload. The internal token authorizes ONLY this download
 *     decision and never a capability-guarded route.
 *
 * Part B is proved two ways: (1) directly against the exported production decision
 * function, and (2) end-to-end against the REAL Express model router mounted in a test
 * app and driven over HTTP — not a source-code regex. Capability resolution runs against
 * the fake MySQL harness; the internal-token env is set only for these tests.
 */
import { test, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();
const { requireBimManagement, authorizeModelVersionDownload } =
  await import("../../applicationIdentity/applicationAuthorization.ts");
const { INTERNAL_SERVICE_TOKEN_HEADER, INTERNAL_SERVICE_TOKEN_ENV } =
  await import("../../applicationIdentity/internalServiceAuth.ts");
const modelApp = (await import("../../routes/model.ts")).default;

const INTERNAL_TOKEN = "test-only-internal-token-3c7d19";
let savedTokenEnv: string | undefined;
before(() => { savedTokenEnv = process.env[INTERNAL_SERVICE_TOKEN_ENV]; process.env[INTERNAL_SERVICE_TOKEN_ENV] = INTERNAL_TOKEN; });
after(() => { if (savedTokenEnv === undefined) delete process.env[INTERNAL_SERVICE_TOKEN_ENV]; else process.env[INTERNAL_SERVICE_TOKEN_ENV] = savedTokenEnv; });
beforeEach(() => fakeConnection.reset());

// active human account with the given role (or none). Drives resolveCapabilities.
const CAP_SQL = /application_account_roles/i;
function respondRole(role: string | null) {
  respond([[CAP_SQL, [[{ status: "active", account_kind: "human", normalized_role_key: role }]]]]);
}

function mockRes() {
  const r: any = { statusCode: 0, body: null, done: false };
  r.status = (s: number) => { r.statusCode = s; return r; };
  r.json = (b: any) => { r.body = b; r.done = true; return r; };
  return r;
}
function mockReq(opts: { identity?: any; token?: string } = {}) {
  const headers: Record<string, unknown> = {};
  if (opts.token !== undefined) headers[INTERNAL_SERVICE_TOKEN_HEADER] = opts.token;
  return { headers, applicationIdentity: opts.identity } as any;
}

/* ============ A. initial-upload authorization (requireBimManagement) ============ */

test("A1 unauthenticated POST /api/model/upload is rejected (401), next not called", async () => {
  const req = mockReq(), res = mockRes();
  let nexted = false;
  await requireBimManagement(req, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "session_required");
});

test("A2 authenticated account WITHOUT bimManagement is rejected (403), next not called", async () => {
  respondRole(null); // active human, no management role
  const req = mockReq({ identity: { accountId: 1 } }), res = mockRes();
  let nexted = false;
  await requireBimManagement(req, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "bim_management_required");
});

test("A3 authenticated bim_manager account is accepted (next called, no error body)", async () => {
  respondRole("bim_manager"); // manager-demo-001 holds this role
  const req = mockReq({ identity: { accountId: 1 } }), res = mockRes();
  let nexted = false;
  await requireBimManagement(req, res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(res.done, false, "no response written when authorized");
});

/* ---- Change C correction pass: narrow gaps in upload-guard role coverage ----
 * A2 already covers the role-less ("student") account at the guard. These add the two
 * genuinely uncovered cases: an operational_manager-only account, and additive multi-role
 * accounts, asserted against requireBimManagement itself rather than only against
 * resolveCapabilities. Existing authorization behaviour is NOT modified — students and
 * operational managers are already correctly forbidden; these lock that in.
 */
function respondRoles(roles: string[]) {
  respond([[CAP_SQL, [roles.map((normalized_role_key) => ({ status: "active", account_kind: "human", normalized_role_key }))]]]);
}

test("A4 operational_manager-only account CANNOT upload IFC (403 bim_management_required)", async () => {
  respondRoles(["operational_manager"]);
  const req = mockReq({ identity: { accountId: 2 } }), res = mockRes();
  let nexted = false;
  await requireBimManagement(req, res, () => { nexted = true; });
  assert.equal(nexted, false, "reservation authority must never imply BIM authority");
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "bim_management_required");
});

test("A5 multi-role account holding bim_manager may upload IFC (roles are additive)", async () => {
  respondRoles(["operational_manager", "bim_manager"]);
  const req = mockReq({ identity: { accountId: 3 } }), res = mockRes();
  let nexted = false;
  await requireBimManagement(req, res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(res.done, false, "no response written when authorized");
});

test("A6 adding a further role alongside bim_manager does not remove BIM authority", async () => {
  // Order-independence: the extra grant must not shadow or override bim_manager.
  for (const roles of [["bim_manager", "operational_manager"], ["operational_manager", "bim_manager"]]) {
    respondRoles(roles);
    const req = mockReq({ identity: { accountId: 4 } }), res = mockRes();
    let nexted = false;
    await requireBimManagement(req, res, () => { nexted = true; });
    assert.equal(nexted, true, `bim_manager authority lost with grants [${roles.join(", ")}]`);
  }
});

/* ============ B. model-version download dual authorization (PRODUCTION fn) ============ */

test("B1 reserveResources session (no token) is authorized", async () => {
  respondRole(null); // active human → reserveResources true
  const req = mockReq({ identity: { accountId: 7 } }), res = mockRes();
  assert.equal(await authorizeModelVersionDownload(req, res), true);
});

test("B2 no session and no internal credential is rejected (401)", async () => {
  const req = mockReq(), res = mockRes();
  assert.equal(await authorizeModelVersionDownload(req, res), false);
  assert.equal(res.statusCode, 401);
});

test("B3 an incorrect internal credential (no session) is rejected", async () => {
  const req = mockReq({ token: "wrong-token" }), res = mockRes();
  assert.equal(await authorizeModelVersionDownload(req, res), false);
  assert.equal(res.statusCode, 401);
});

test("B4 a correct internal credential authorizes WITHOUT any capability lookup", async () => {
  const req = mockReq({ token: INTERNAL_TOKEN }), res = mockRes();
  assert.equal(await authorizeModelVersionDownload(req, res), true);
  assert.equal(res.done, false, "no response written on the internal-token path");
  assert.equal(fakeConnection.callsMatching(CAP_SQL).length, 0, "capability DB is never consulted for the internal token");
});

test("B5 the internal credential does NOT authorize an unrelated capability-guarded route", async () => {
  // Present the valid internal token to a bimManagement guard with no session: it must
  // still be rejected — capability guards never consult the internal-service header.
  const req = mockReq({ token: INTERNAL_TOKEN }), res = mockRes();
  let nexted = false;
  await requireBimManagement(req, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 401, "the internal token grants no capability");
  assert.equal(res.body.code, "session_required");
});

test("B6 the internal token never appears in a rejection body", async () => {
  const req = mockReq({ token: "wrong-token" }), res = mockRes();
  await authorizeModelVersionDownload(req, res);
  assert.equal(JSON.stringify(res.body).includes(INTERNAL_TOKEN), false);
});

/* ============ C. REAL Express route mounted and driven over HTTP ============ */
// A parent app injects an optional synthetic identity (header x-test-account) before the
// real model router, so we exercise the ACTUAL route handler and its authorization guard.

let server: import("node:http").Server;
let baseUrl = "";
before(async () => {
  const parent = express();
  parent.use((req, _res, next) => {
    const acct = req.headers["x-test-account"];
    if (typeof acct === "string" && acct.length > 0) (req as any).applicationIdentity = { accountId: Number(acct) };
    next();
  });
  parent.use(modelApp);
  await new Promise<void>((resolve) => { server = parent.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

test("C1 real route: no token, no session → 401 and no file body", async () => {
  fakeConnection.reset(); // capability DB must never be reached (no identity)
  const res = await fetch(`${baseUrl}/versions/5/download`);
  assert.equal(res.status, 401);
  assert.notEqual(res.headers.get("content-type"), "application/octet-stream");
  assert.equal(fakeConnection.callsMatching(CAP_SQL).length, 0);
});

test("C2 real route: valid internal token authorizes and the version id reaches the route (404, no capability lookup)", async () => {
  fakeConnection.reset();
  respond([[/FROM model_versions/i, [[]]]]); // version 5 not found → 404 AFTER authorization
  const res = await fetch(`${baseUrl}/versions/5/download`, { headers: { [INTERNAL_SERVICE_TOKEN_HEADER]: INTERNAL_TOKEN } });
  assert.equal(res.status, 404, "authorization passed; the real handler looked up version 5");
  assert.equal(fakeConnection.callsMatching(CAP_SQL).length, 0, "the internal token never triggers a capability lookup");
  assert.equal(fakeConnection.callsMatching(/FROM model_versions/i).length >= 1, true, "the requested version id reached the real route");
});

test("C3 real route: wrong internal token, no session → 401", async () => {
  fakeConnection.reset();
  const res = await fetch(`${baseUrl}/versions/5/download`, { headers: { [INTERNAL_SERVICE_TOKEN_HEADER]: "wrong-token" } });
  assert.equal(res.status, 401);
});

test("C4 real route: reserveResources session (no token) authorizes", async () => {
  fakeConnection.reset();
  respondRole(null); // active human → reserveResources true; version lookup falls through to [[]] → 404
  const res = await fetch(`${baseUrl}/versions/5/download`, { headers: { "x-test-account": "7" } });
  assert.equal(res.status, 404, "session authorized; version 5 not found");
  assert.equal(fakeConnection.callsMatching(CAP_SQL).length >= 1, true, "a capability lookup ran for the session path");
});

test("C5 real route: POST /upload without a session is rejected before multer (401)", async () => {
  fakeConnection.reset();
  const res = await fetch(`${baseUrl}/upload`, { method: "POST" });
  assert.equal(res.status, 401);
  const body: any = await res.json();
  assert.equal(body.code, "session_required");
});
