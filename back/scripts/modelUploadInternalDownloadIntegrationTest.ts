/**
 * Disposable cross-language + persistence integration regression for
 * fix/model-upload-internal-download-auth.
 *
 * BOUNDARY (stated honestly): this is a LANGUAGE-BOUNDARY + PERSISTENCE integration test.
 * It exercises the REAL Python download client against a REAL Node HTTP server that uses
 * the REAL hasValidInternalServiceToken guard, and the REAL Stage 0B persistence on a
 * throwaway schema. It does NOT stand up the full Express model router — the actual
 * Express route (GET /versions/:versionId/download) and its dual-auth guard are covered
 * separately and end-to-end in tests/semantic/modelRouteAuthorization.test.ts (C1–C5).
 * It NEVER uses digital_twin, Edifício A/B, or Fuseki.
 *
 * PART 1 — real Python↔Node internal-service auth + TRUSTED-URL construction:
 *   - a real Node http server serves the model-version download and enforces the REAL
 *     token guard (no session is ever attached, so ONLY the internal token authorizes —
 *     exactly the boundary the fix repairs; the original code 401'd this request);
 *   - the REAL Python model_download.download_version_file is invoked as a subprocess and
 *     is given only a NUMERIC version id — it constructs the download URL itself from the
 *     trusted MODEL_VERSION_DOWNLOAD_BASE_URL, so the server sees exactly the expected
 *     trusted path /api/model/versions/<id>/download;
 *   - correct token → 200 + bytes; wrong/absent token → 401 → ModelDownloadError, token
 *     never in the subprocess output; the bytes feed the REAL build_inventory_payload
 *     (3 spaces, 3 lossless occurrences, exact GlobalIds, no interpreted Reference).
 *
 * PART 1R — REVIEW REGRESSION (would have failed under the reviewed patch): a second,
 *   attacker-controlled "sink" server is started. The driver is handed an attacker
 *   ABSOLUTE URL pointing at that sink as the version id. Under the reviewed patch (which
 *   used a caller-supplied `path` verbatim) the token would have been sent to the sink.
 *   Under the fix the id is rejected before any HTTP request: the sink receives ZERO
 *   requests and the token is never disclosed.
 *
 * PART 2 — Stage 0B persistence on a disposable schema (real MySQL, no digital_twin):
 *   - the extracted occurrences/candidates are persisted via the REAL
 *     persistSpaceIdentities → exactly 3 persistent spaces + 3 version bindings, keyed by
 *     linked_model + exact GlobalId;
 *   - a second version with the SAME GlobalIds but CHANGED References REUSES the same 3
 *     space ids (identity is by GlobalId, never by Reference) and creates 3 new bindings.
 *
 * Cleanup is robust and fatal: the disposable schema, temp files, pools, both HTTP servers
 * and the server connection are all torn down; any cleanup failure forces a non-zero exit.
 *
 * Usage: cd back && npx tsx scripts/modelUploadInternalDownloadIntegrationTest.ts
 */
import "dotenv/config";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import mysql from "mysql2/promise";
import { hasValidInternalServiceToken, INTERNAL_SERVICE_TOKEN_HEADER } from "../applicationIdentity/internalServiceAuth.ts";

const execFileAsync = promisify(execFile);

let passes = 0, failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passes++; console.log(`    PASS  ${name}`); }
  else { failures++; console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

const TOKEN = `itest-internal-${crypto.randomBytes(8).toString("hex")}`;
const S1 = "0INTEGRATIONSPACE00001";
const S2 = "0INTEGRATIONSPACE00002";
const S3 = "0INTEGRATIONSPACE00003";
const GUIDS = [S1, S2, S3];

const pyExe = process.env.IDS_PYTHON_EXECUTABLE ?? path.resolve(process.cwd(), "python", "venv", "Scripts", "python.exe");
const pyDir = path.resolve(process.cwd(), "python");
// Committed geometry-free IFC4 fixture (3 spaces S1/S2/S3, References T-101/102/103).
const FIXTURE = path.resolve(process.cwd(), "tests/fixtures/stage0b-three-space-baseline.ifc");

// Python driver: given ONLY a numeric version id, the real client constructs the trusted
// download URL from MODEL_VERSION_DOWNLOAD_BASE_URL, presents the internal-service token,
// then runs the REAL endpoint-used extractor. Emits JSON on success; exits non-zero on a
// download failure (including a rejected, non-numeric / attacker version id).
const DRIVER_SNIPPET = `
import sys, json, os
sys.path.insert(0, ${JSON.stringify(pyDir)})
from model_download import download_version_file, ModelDownloadError
from service_config import ConfigError
version_id, out = sys.argv[1], sys.argv[2]
try:
    data = download_version_file(version_id)
except (ModelDownloadError, ConfigError) as e:
    sys.stderr.write("DOWNLOAD_FAILED:" + str(e))
    sys.exit(3)
open(out, "wb").write(data)
import ifcopenshell_utils as u
print(json.dumps(u.build_inventory_payload(out)))
`;

async function createSchemaObjects(conn: mysql.Connection): Promise<void> {
  await conn.query("CREATE TABLE entities (id INT NOT NULL AUTO_INCREMENT, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci");
  await conn.query("CREATE TABLE linked_models (id INT NOT NULL AUTO_INCREMENT, name VARCHAR(200) DEFAULT NULL, spatial_authority_model_id INT DEFAULT NULL, PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci");
  await conn.query("CREATE TABLE models (id INT NOT NULL AUTO_INCREMENT, model_uuid CHAR(36) NOT NULL, linked_parent_id INT DEFAULT NULL, PRIMARY KEY (id), UNIQUE KEY uq_models_uuid (model_uuid), CONSTRAINT fk_m_linked_parent FOREIGN KEY (linked_parent_id) REFERENCES linked_models (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci");
  await conn.query("CREATE TABLE model_versions (id INT NOT NULL AUTO_INCREMENT, version_uuid CHAR(36) NOT NULL, model_id INT NOT NULL, version_number INT DEFAULT NULL, PRIMARY KEY (id), UNIQUE KEY uq_model_versions_uuid (version_uuid), CONSTRAINT model_versions_ibfk_1 FOREIGN KEY (model_id) REFERENCES models (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci");
  await conn.query(`CREATE TABLE spaces (
      id INT NOT NULL AUTO_INCREMENT, space_uuid CHAR(36) NOT NULL,
      ifc_global_id CHAR(22) CHARACTER SET ascii COLLATE ascii_bin NULL,
      inventory_code VARCHAR(200) NOT NULL, inventory_code_normalized VARCHAR(200) NOT NULL,
      linked_model_id INT NOT NULL, name VARCHAR(255) DEFAULT NULL,
      status ENUM('active','absent','retired') NOT NULL DEFAULT 'active',
      PRIMARY KEY (id), UNIQUE KEY uq_spaces_uuid (space_uuid),
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

async function main() {
  const operationalDb = process.env.DB_NAME;
  const schema = `oswadt_uploadauth_itest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  if (schema === operationalDb) throw new Error("refusing to reuse the operational database name");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oswadt-upload-itest-"));
  const ifcPath = path.join(tmpDir, "model.ifc");
  const dlPath = path.join(tmpDir, "downloaded.ifc");

  const baseConfig = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, multipleStatements: false } as any;
  const server = await mysql.createConnection(baseConfig);

  let httpServer: http.Server | undefined;
  let sinkServer: http.Server | undefined;
  let conn: mysql.Connection | undefined;
  let spaceDb: any;
  let schemaCreated = false, schemaDropped = false;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];

  // The internal-service token must be present for BOTH the Node guard (process.env) and
  // the Python subprocess (its own env). Never a real/production secret.
  const savedToken = process.env.OSWADT_INTERNAL_SERVICE_TOKEN;
  process.env.OSWADT_INTERNAL_SERVICE_TOKEN = TOKEN;

  try {
    console.log(JSON.stringify({ event: "upload_internal_download_itest_start", disposableSchema: schema, operationalDatabase: operationalDb, note: "digital_twin is never selected or modified" }));

    // ---- stage the committed geometry-free IFC fixture ----
    fs.copyFileSync(FIXTURE, ifcPath);
    check("synthetic IFC fixture staged", fs.existsSync(ifcPath) && fs.statSync(ifcPath).size > 0);

    // ---- PART 1: real Node download guard (real GET /api/model/versions/<id>/download) ----
    const servedPaths: string[] = [];
    httpServer = http.createServer((req, res) => {
      servedPaths.push(req.url ?? "");
      // No session is ever attached here, so ONLY the internal token authorizes — exactly
      // the boundary the fix repairs (the original code 401'd this request).
      if (!hasValidInternalServiceToken(req as any)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, code: "session_required" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(fs.readFileSync(ifcPath));
    });
    await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", () => resolve()));
    const port = (httpServer.address() as any).port;
    // Python is given ONLY the trusted base + a numeric id; it builds the URL itself.
    const versionBase = `http://127.0.0.1:${port}/api/model/versions`;
    const driverEnv = (token: string | null) => {
      const base: Record<string, string> = { ...process.env as any, MODEL_VERSION_DOWNLOAD_BASE_URL: versionBase };
      if (token === null) delete base.OSWADT_INTERNAL_SERVICE_TOKEN; else base.OSWADT_INTERNAL_SERVICE_TOKEN = token;
      return base;
    };

    // 1a. correct token + numeric id → success + real extraction; server sees the trusted path
    const okRun = await execFileAsync(pyExe, ["-c", DRIVER_SNIPPET, "1", dlPath],
      { cwd: pyDir, timeout: 60000, maxBuffer: 8 * 1024 * 1024, env: driverEnv(TOKEN) });
    const payload = JSON.parse(okRun.stdout.trim());
    check("1a correct internal token → download authorized + payload built", payload.ok === true && payload.status === "success");
    check("1a Python constructed the exact trusted path (no caller-selected URL)", servedPaths.includes("/api/model/versions/1/download"), `served=${JSON.stringify(servedPaths)}`);
    check("1a extraction reached inventory (3 GlobalId-keyed spaces)", Object.keys(payload.data).length === 3);
    check("1a lossless occurrences present (3)", Array.isArray(payload.spaceOccurrences) && payload.spaceOccurrences.length === 3);
    const occGuids = payload.spaceOccurrences.map((o: any) => o.guid).sort();
    check("1a exact GlobalIds extracted", JSON.stringify(occGuids) === JSON.stringify([...GUIDS].sort()));
    check("1a no interpreted Reference field on occurrences (raw psets only)",
      payload.spaceOccurrences.every((o: any) => !("reference" in o) && "psets" in o));
    check("1a downloaded bytes match the source IFC", fs.existsSync(dlPath) && fs.readFileSync(dlPath).equals(fs.readFileSync(ifcPath)));

    // 1b. wrong token → rejected, no token leak
    const wrongRun = await execFileAsync(pyExe, ["-c", DRIVER_SNIPPET, "1", dlPath],
      { cwd: pyDir, timeout: 60000, env: driverEnv("wrong-token") }).then(() => ({ code: 0, stderr: "" }), (e: any) => ({ code: e.code, stderr: String(e.stderr ?? "") }));
    check("1b wrong internal token → Python download failed (non-zero)", wrongRun.code === 3 && /DOWNLOAD_FAILED/.test(wrongRun.stderr));
    check("1b failure carries status 401, never the token", /401/.test(wrongRun.stderr) && !wrongRun.stderr.includes(TOKEN));

    // 1c. absent token → controlled config failure, no request accepted
    const noneRun = await execFileAsync(pyExe, ["-c", DRIVER_SNIPPET, "1", dlPath],
      { cwd: pyDir, timeout: 60000, env: driverEnv(null) }).then(() => ({ code: 0, stderr: "" }), (e: any) => ({ code: e.code, stderr: String(e.stderr ?? "") }));
    check("1c absent internal token → Python fails before/at download (non-zero)", noneRun.code === 3 && /DOWNLOAD_FAILED/.test(noneRun.stderr));
    check("1c absent-token failure never contains the token", !noneRun.stderr.includes(TOKEN));

    // ---- PART 1R: REVIEW REGRESSION — an attacker-controlled URL cannot exfiltrate the token ----
    let sinkHits = 0;
    let sinkTokenSeen = false;
    sinkServer = http.createServer((req, res) => {
      sinkHits += 1;
      if (req.headers[INTERNAL_SERVICE_TOKEN_HEADER] !== undefined) sinkTokenSeen = true;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(fs.readFileSync(ifcPath)); // a cooperative attacker sink would happily accept the token
    });
    await new Promise<void>((resolve) => sinkServer!.listen(0, "127.0.0.1", () => resolve()));
    const sinkPort = (sinkServer.address() as any).port;
    // The attacker tries to smuggle an ABSOLUTE URL (pointing at the sink) as the version id.
    // Under the reviewed patch (verbatim `path`) this would fetch the sink WITH the token.
    const attackerUrl = `http://127.0.0.1:${sinkPort}/api/model/versions/1/download`;
    const sinkHitsBefore = sinkHits;
    const attackRun = await execFileAsync(pyExe, ["-c", DRIVER_SNIPPET, attackerUrl, dlPath],
      { cwd: pyDir, timeout: 60000, env: driverEnv(TOKEN) }).then(() => ({ code: 0, stderr: "" }), (e: any) => ({ code: e.code, stderr: String(e.stderr ?? "") }));
    check("1R attacker URL as version id → rejected before any HTTP (non-zero)", attackRun.code === 3 && /DOWNLOAD_FAILED/.test(attackRun.stderr));
    check("1R attacker sink received ZERO requests", sinkHits === sinkHitsBefore && sinkHits === 0);
    check("1R the token was never sent to the attacker sink", sinkTokenSeen === false);
    check("1R the token never appears in the failure output", !attackRun.stderr.includes(TOKEN));

    // ---- PART 2: Stage 0B persistence on a disposable schema ----
    await server.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    schemaCreated = true;
    conn = await mysql.createConnection({ ...baseConfig, database: schema } as any);
    await createSchemaObjects(conn);

    process.env.DB_NAME = schema; // bind the singletons to the disposable schema BEFORE import
    spaceDb = (await import("../utils/spaceDatabase.ts")).default;
    const service = await import("../services/spaceIdentityService.ts");
    const identityProvider = await import("../identity/spaceIdentityProvider.ts");
    // Install a self-test resolver that reads a plain `reference` field, so this script
    // never names the identity property set (architecture guard: the pset name lives only
    // in back/identity/). The Reference itself is extracted generically below.
    identityProvider.setSpaceIdentityResolver({
      resolve: async (c: any) => ({ status: "valid", rawValue: c.reference, normalizedValue: c.reference,
        source: "ITest.Reference", reasons: [], resolverId: "itest", resolvedAt: new Date().toISOString(), guid: c.guid }),
    });
    // Extract the identity Reference WITHOUT naming any property set (scan pset values).
    const referenceOf = (psets: any): string | null => {
      for (const pset of Object.values(psets ?? {})) {
        const value = (pset as any)?.Reference;
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return null;
    };

    const [dbRow]: any = await conn.query("SELECT DATABASE() AS db");
    check("2 disposable schema selected (not digital_twin)", dbRow[0].db === schema && dbRow[0].db !== operationalDb, `db=${dbRow[0].db}`);

    // seed linked_model + model + version + 3 entities
    const [lm]: any = await conn.query("INSERT INTO linked_models (name) VALUES ('ITest LM')");
    const linkedModelId = Number(lm.insertId);
    const [md]: any = await conn.query("INSERT INTO models (model_uuid, linked_parent_id) VALUES (?, ?)", [crypto.randomUUID(), linkedModelId]);
    const modelId = Number(md.insertId);
    const seedVersion = async () => {
      const [v]: any = await conn!.query("INSERT INTO model_versions (version_uuid, model_id, version_number) VALUES (?, ?, 1)", [crypto.randomUUID(), modelId]);
      return Number(v.insertId);
    };
    const seedEntity = async () => { const [e]: any = await conn!.query("INSERT INTO entities () VALUES ()"); return Number(e.insertId); };

    // Build candidates (DB entity ids) + occurrences (IFC entity ids) from the REAL extraction.
    const inv = payload.data as Record<string, any>;
    const occByGuid = new Map(payload.spaceOccurrences.map((o: any) => [o.guid, o]));
    const v1 = await seedVersion();
    const candidates1: any[] = [];
    for (const guid of GUIDS) {
      const s = inv[guid];
      candidates1.push({ guid, name: s.spaceName, longName: s.spaceLongName, reference: referenceOf(s.psets), entityId: await seedEntity() });
    }
    const occurrences1 = GUIDS.map((guid) => {
      const o: any = occByGuid.get(guid);
      return { guid, name: o.name, longName: o.longName, entityId: o.entityId, storeyName: o.storeyName ?? null };
    });

    const out1 = await service.persistSpaceIdentities({ linkedModelId, modelId, modelVersionId: v1, candidates: candidates1, occurrences: occurrences1 });
    check("2a exactly 3 persistent spaces created", out1.diagnostics.created_spaces === 3 && out1.createdSpaceIds.length === 3);
    check("2a exactly 3 version bindings created", out1.bindingsCreated === 3);
    const [spaceRows]: any = await conn.query("SELECT ifc_global_id, id FROM spaces WHERE linked_model_id = ? ORDER BY ifc_global_id", [linkedModelId]);
    check("2a spaces carry the exact case-sensitive GlobalIds", JSON.stringify(spaceRows.map((r: any) => r.ifc_global_id)) === JSON.stringify([...GUIDS].sort()));
    const [bindRows]: any = await conn.query("SELECT ifc_guid FROM space_bindings WHERE model_version_id = ? ORDER BY ifc_guid", [v1]);
    check("2a bindings carry the canonical GlobalIds", JSON.stringify(bindRows.map((r: any) => r.ifc_guid)) === JSON.stringify([...GUIDS].sort()));
    const idByGuid = new Map(spaceRows.map((r: any) => [r.ifc_global_id, r.id]));

    // 2b. second version, SAME GlobalIds, CHANGED References → reuse by GlobalId, NOT by Reference.
    const v2 = await seedVersion();
    const candidates2: any[] = [];
    for (const guid of GUIDS) {
      const s = inv[guid];
      candidates2.push({ guid, name: s.spaceName, longName: s.spaceLongName, reference: `${referenceOf(s.psets)}-NEW`, entityId: await seedEntity() });
    }
    const out2 = await service.persistSpaceIdentities({ linkedModelId, modelId, modelVersionId: v2, candidates: candidates2, occurrences: occurrences1 });
    check("2b changed References reuse the SAME 3 spaces (0 new)", out2.diagnostics.created_spaces === 0 && out2.diagnostics.reused_spaces === 3);
    const [spaceRows2]: any = await conn.query("SELECT ifc_global_id, id, inventory_code_normalized FROM spaces WHERE linked_model_id = ?", [linkedModelId]);
    const sameIds = spaceRows2.every((r: any) => Number(idByGuid.get(r.ifc_global_id)) === Number(r.id));
    check("2b persistent space ids unchanged (identity by GlobalId, never by Reference)", sameIds && spaceRows2.length === 3);
    check("2b administrative References were updated (…-NEW)", spaceRows2.every((r: any) => /-NEW$/.test(r.inventory_code_normalized)));
    check("2b second version added 3 new bindings", out2.bindingsCreated === 3);
  } catch (e) {
    primaryError = e;
    console.error(`primary error: ${String((e as any)?.message ?? e)}`);
  } finally {
    process.env.DB_NAME = operationalDb; // restore before any further use
    if (savedToken === undefined) delete process.env.OSWADT_INTERNAL_SERVICE_TOKEN; else process.env.OSWADT_INTERNAL_SERVICE_TOKEN = savedToken;
    if (spaceDb) { try { await spaceDb["db"].disconnect(); } catch (e) { cleanupErrors.push(e); } }
    if (conn) { try { await conn.end(); } catch (e) { cleanupErrors.push(e); } }
    if (httpServer) { try { await new Promise<void>((r) => httpServer!.close(() => r())); } catch (e) { cleanupErrors.push(e); } }
    if (sinkServer) { try { await new Promise<void>((r) => sinkServer!.close(() => r())); } catch (e) { cleanupErrors.push(e); } }
    if (schemaCreated) {
      try { await server.query(`DROP DATABASE \`${schema}\``); schemaDropped = true; }
      catch (e) { cleanupErrors.push(e); console.error(`FAILED to drop disposable schema '${schema}': manual DROP DATABASE required`); }
    }
    try { await server.end(); } catch (e) { cleanupErrors.push(e); }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { cleanupErrors.push(e); }
  }

  console.log(JSON.stringify({ event: "upload_internal_download_itest_end", disposableSchema: schema, schemaCreated, schemaDropped, cleanupErrorCount: cleanupErrors.length, passes, failures, primaryErrorPresent: primaryError !== undefined }));
  console.log(`\n  ${passes} checks passed, ${failures} failed.`);
  if (primaryError !== undefined || failures > 0 || cleanupErrors.length > 0) process.exit(1);
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
