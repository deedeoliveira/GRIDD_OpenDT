/**
 * Change C — Option B governance model: MODEL INTAKE NEVER ACCEPTS AN IDS.
 *
 * There is no way, from any model-intake-facing surface, to select or upload an IDS
 * profile — not in the authoritative version-creation path and not in the standalone
 * preview (preflight) either. A future IDS revision is introduced only through a separate
 * BIM-manager IDS-governance workflow (register -> validate -> activate -> become
 * current), which this pass deliberately does NOT build.
 *
 * Proved here:
 *  A. Public contract — `idsMode`/`idsFile` are absent from the model-intake request
 *     shape (multer accept list, route helpers, service DTOs).
 *  B. Fail-closed — a LEGACY caller that still sends `idsMode` or an `idsFile` part is
 *     REJECTED (422 controlled_intake_requires_governed_ids) over real HTTP against the
 *     real Express router, before any model lookup / context capture / side effect.
 *  C. Preview resolution — standalone preflight unconditionally resolves the governed
 *     CURRENT (active) IDS, is never pinned across requests, and therefore picks up a
 *     newer revision on a later call once governance activates one.
 *  D. Authoritative resolution — pinned to context.ids via resolveByArtifactId, with no
 *     resolveActive fallback.
 *  E. No temporary/uploaded IDS source label or temporary-IDS URI is reachable from
 *     model intake.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import type { AddressInfo } from "node:net";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();
process.env.MODEL_INTAKE_WORKSPACE_ENABLED = "true";

const routesSource = fs.readFileSync("routes/modelIntake.ts", "utf8");
const intakeSource = fs.readFileSync("modelIntake/modelIntakeService.ts", "utf8");

/* =================== A. the IDS override is gone from the contract =================== */

test("A1 neither model-intake multipart endpoint accepts an idsFile part", () => {
    const preflight = routesSource.slice(routesSource.indexOf('app.post("/preflight"'));
    assert.match(preflight, /app\.post\("\/preflight", upload\.fields\(\[\{ name: "ifcFile", maxCount: 1 \}\]\)/);
    const versions = routesSource.slice(routesSource.indexOf('app.post("/models/:modelId/versions"'));
    assert.match(versions, /upload\.fields\(\[\{ name: "ifcFile", maxCount: 1 \}\]\)/);
    // The IFC upload itself is untouched — this is still a multipart endpoint.
    assert.ok(routesSource.includes('name: "ifcFile"'), "the BIM manager still uploads the IFC via multipart");
});

test("A2 the idsMode request-field parser no longer exists on the model-intake surface", () => {
    assert.doesNotMatch(routesSource, /function idsMode\(/);
    assert.doesNotMatch(routesSource, /invalid_ids_mode/);
    // No handler forwards an IDS selection to the service.
    assert.doesNotMatch(routesSource, /idsMode: idsMode\(/);
    assert.doesNotMatch(routesSource, /idsFile: selected\.idsFile/);
});

test("A3 neither service DTO carries idsMode/idsFile", () => {
    assert.match(intakeSource, /async preflight\(input: \{ ifcFile: UploadedFile; modelId: number \}/);
    assert.match(intakeSource, /async createVersion\(input: \{ preflightRunUuid: string; ifcFile: UploadedFile; modelId: number \}\)/);
});

test("A4 resolveProfile has exactly two governed modes and no uploaded branch", () => {
    const resolve = intakeSource.slice(intakeSource.indexOf("private async resolveProfile("));
    assert.match(resolve, /private async resolveProfile\(correlationId: string, context\?: SemanticExecutionContext\)/);
    // (a) pinned by artifact id when a context is present, (b) active otherwise. Nothing else.
    assert.match(resolve, /context\s*\?\s*await this\.profiles\.resolveByArtifactId\(context\.ids\)\s*:\s*await this\.profiles\.resolveActive\(idsConfig\.familyKey\)/);
    assert.doesNotMatch(resolve, /temporary_uploaded_profile/);
    assert.doesNotMatch(resolve, /temporary-upload/);
    assert.doesNotMatch(resolve, /ids_file_required/);
});

test("A5 model intake never mints a temporary-IDS URI and never labels a profile temporary", () => {
    // The whole intake service, not just resolveProfile.
    assert.doesNotMatch(intakeSource, /temporary_ids_profile_received/);
    assert.doesNotMatch(intakeSource, /source: "temporary_uploaded_profile"/);
    assert.doesNotMatch(intakeSource, /baseUri\}\/temporary-ids-profile/);
    // The preview RDF always points at the governed semantic artifact.
    assert.match(intakeSource, /idsProfileUri: `\$\{graph\.config\.baseUri\}\/semantic-artifact\/\$\{profile\.artifactUuid\}`/);
});

test("A6 the intake context payload advertises no IDS upload affordance", () => {
    const context = intakeSource.slice(intakeSource.indexOf("async context()"), intakeSource.indexOf("async versionResources("));
    assert.doesNotMatch(context, /temporaryIdsUploadEnabled/);
    assert.doesNotMatch(context, /maxIdsBytes/);
    assert.match(context, /limits: \{ maxIfcBytes: config\.maxIfcBytes \}/);
});

test("A7 the removed IDS upload took its temporary-IDS cleanup with it, IFC cleanup stays", () => {
    assert.doesNotMatch(intakeSource, /removeTempFile\(input\.idsFile\.path\)/);
    assert.match(intakeSource, /if \(store\) removeTempFile\(input\.ifcFile\.path\);/);
    assert.match(intakeSource, /if \(fs\.existsSync\(input\.ifcFile\.path\)\) removeTempFile\(input\.ifcFile\.path\);/);
});

/* ============ B. legacy override attempts are rejected over real HTTP ============ */

let baseUrl = "";
let server: ReturnType<express.Express["listen"]>;

before(async () => {
    const modelIntakeApp = (await import("../../routes/modelIntake.ts")).default;
    const app = express();
    // Authenticate as a BIM manager so the requireBimManagement gate (unchanged by this
    // pass) is satisfied and we are genuinely exercising the intake handlers.
    app.use((req: any, _res, next) => { req.applicationIdentity = { accountId: 1 }; next(); });
    app.use("/modelIntake", modelIntakeApp);
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/modelIntake`;
});
after(() => { server?.close(); });

beforeEach(() => {
    fakeConnection.reset();
    // Active human bim_manager for capability resolution.
    respond([[/application_account_roles/i, [[{ status: "active", account_kind: "human", normalized_role_key: "bim_manager" }]]]]);
});

const GOVERNED_CODE_MESSAGE = /governed IDS revision/i;

function ifcBlob() {
    return new Blob(["ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"], { type: "application/octet-stream" });
}

test("B1 POST /preflight with a legacy idsMode field is rejected 422 before any work", async () => {
    const form = new FormData();
    form.set("ifcFile", ifcBlob(), "model.ifc");
    form.set("modelId", "1");
    form.set("idsMode", "active");
    const response = await fetch(`${baseUrl}/preflight`, { method: "POST", body: form });
    const payload: any = await response.json();
    assert.equal(response.status, 422);
    assert.match(payload.message, GOVERNED_CODE_MESSAGE);
    // Fail-closed, not "ignore the IDS and use current instead".
    assert.notEqual(payload.ok, true);
});

test("B2 POST /preflight with idsMode='uploaded' is rejected 422 (no exploratory IDS)", async () => {
    const form = new FormData();
    form.set("ifcFile", ifcBlob(), "model.ifc");
    form.set("modelId", "1");
    form.set("idsMode", "uploaded");
    const response = await fetch(`${baseUrl}/preflight`, { method: "POST", body: form });
    assert.equal(response.status, 422);
    assert.match((await response.json() as any).message, GOVERNED_CODE_MESSAGE);
});

test("B3 POST /preflight streaming an actual idsFile part is rejected 422", async () => {
    const form = new FormData();
    form.set("ifcFile", ifcBlob(), "model.ifc");
    form.set("modelId", "1");
    form.set("idsFile", new Blob(["<ids/>"], { type: "text/xml" }), "profile.ids");
    const response = await fetch(`${baseUrl}/preflight`, { method: "POST", body: form });
    assert.equal(response.status, 422);
    assert.match((await response.json() as any).message, GOVERNED_CODE_MESSAGE);
});

test("B4 POST /models/:modelId/versions with a legacy idsMode field is rejected 422", async () => {
    const form = new FormData();
    form.set("ifcFile", ifcBlob(), "model.ifc");
    form.set("preflightRunUuid", "00000000-0000-4000-8000-000000000000");
    form.set("idsMode", "active");
    const response = await fetch(`${baseUrl}/models/1/versions`, { method: "POST", body: form });
    assert.equal(response.status, 422);
    assert.match((await response.json() as any).message, GOVERNED_CODE_MESSAGE);
});

test("B5 POST /models/:modelId/versions streaming an idsFile part is rejected 422", async () => {
    const form = new FormData();
    form.set("ifcFile", ifcBlob(), "model.ifc");
    form.set("preflightRunUuid", "00000000-0000-4000-8000-000000000000");
    form.set("idsFile", new Blob(["<ids/>"], { type: "text/xml" }), "profile.ids");
    const response = await fetch(`${baseUrl}/models/1/versions`, { method: "POST", body: form });
    assert.equal(response.status, 422);
    assert.match((await response.json() as any).message, GOVERNED_CODE_MESSAGE);
});

/* ====== C/D/E. resolution: preview -> governed current, authoritative -> pinned ====== */

/**
 * `resolveProfile` is the single IDS-resolution funnel for BOTH model-intake paths, so
 * driving it directly proves the two-mode collapse without the IFC extraction machinery.
 */
async function serviceWithProfiles(profiles: any) {
    const { ModelIntakeService } = await import("../../modelIntake/modelIntakeService.ts");
    const idsProvider = {
        validateProfile: async (metadata: any) => ({
            profileSha256: metadata.sha256, profileVersion: metadata.version,
            executorName: "fake-executor", executorVersion: "0.0.0", specificationCount: 1, requirements: [],
        }),
    };
    const unreachable = (label: string): any => new Proxy({}, {
        get: (_t, p: string) => () => { throw new Error(`must not be reached: ${label}.${p}`); },
    });
    return new (ModelIntakeService as any)(
        unreachable("database"), idsProvider, profiles, unreachable("mappings"), unreachable("artifactDatabase"),
    );
}

function governedRevision(artifactId: number, version: string) {
    return { artifactId, artifactUuid: `uuid-${artifactId}`, familyKey: "uminho-model-requirements",
        version, sha256: String(artifactId).repeat(64).slice(0, 64), absolutePath: `/artifacts/ids-${version}.ids` };
}

test("C1 standalone preflight resolution uses the governed CURRENT IDS (resolveActive, unpinned)", async () => {
    let activeCalls = 0;
    const service = await serviceWithProfiles({
        resolveActive: async () => { activeCalls += 1; return governedRevision(11, "1.1.0"); },
        resolveByArtifactId: async () => { throw new Error("preview must not pin by artifact id"); },
    });
    const profile = await (service as any).resolveProfile("run-uuid-1");
    assert.equal(activeCalls, 1);
    assert.equal(profile.source, "governed_active_profile");
    assert.equal(profile.artifactId, 11);
    assert.equal(profile.version, "1.1.0");
    // E: no temporary label / no synthetic temporary family key anywhere in the result.
    assert.notEqual(profile.familyKey, "temporary-upload");
    assert.doesNotMatch(JSON.stringify(profile), /temporary/i);
});

test("C2 a later preflight picks up a NEWER governed revision once governance activates one", async () => {
    // Simulated governance activation between two independent preview requests: the
    // preview path is deliberately NOT pinned across requests.
    const revisions = [governedRevision(11, "1.1.0"), governedRevision(12, "1.2.0")];
    let call = 0;
    const service = await serviceWithProfiles({
        resolveActive: async () => revisions[Math.min(call++, revisions.length - 1)],
        resolveByArtifactId: async () => { throw new Error("preview must not pin by artifact id"); },
    });
    const first = await (service as any).resolveProfile("run-uuid-1");
    const second = await (service as any).resolveProfile("run-uuid-2");
    assert.equal(first.artifactId, 11);
    assert.equal(first.version, "1.1.0");
    assert.equal(second.artifactId, 12, "the second preview must see the newly activated revision");
    assert.equal(second.version, "1.2.0");
    assert.equal(second.source, "governed_active_profile");
});

test("D1 authoritative resolution is PINNED to context.ids with no resolveActive fallback", async () => {
    const pinned = { artifactId: 11, artifactUuid: "uuid-11", familyKey: "uminho-model-requirements", version: "1.1.0" };
    let pinnedCalls = 0;
    const service = await serviceWithProfiles({
        resolveActive: async () => { throw new Error("the authoritative path must never re-resolve active"); },
        resolveByArtifactId: async (selection: any) => {
            pinnedCalls += 1;
            assert.deepEqual(selection, pinned, "the pinned selection must be exactly context.ids");
            return governedRevision(11, "1.1.0");
        },
    });
    const profile = await (service as any).resolveProfile("run-uuid-1", { ids: pinned } as any);
    assert.equal(pinnedCalls, 1);
    assert.equal(profile.artifactId, 11);
    assert.equal(profile.source, "governed_active_profile");
});

test("E1 the preflight run's recorded IDS identity is the governed revision it actually used", async () => {
    const service = await serviceWithProfiles({
        resolveActive: async () => governedRevision(12, "1.2.0"),
        resolveByArtifactId: async () => { throw new Error("preview must not pin by artifact id"); },
    });
    // The stored PreflightRun records `this.publicProfile(profile)` of exactly this object.
    const profile = await (service as any).resolveProfile("run-uuid-1");
    const stored = (service as any).publicProfile(profile);
    assert.equal(stored.source, "governed_active_profile");
    assert.equal(stored.artifactId, 12);
    assert.equal(stored.familyKey, "uminho-model-requirements");
    assert.equal(stored.version, "1.2.0");
    assert.equal(stored.sha256, governedRevision(12, "1.2.0").sha256);
    // absolutePath is never exposed; source is never a temporary label.
    assert.equal("absolutePath" in stored, false);
    assert.notEqual(stored.source, "temporary_uploaded_profile");
});
