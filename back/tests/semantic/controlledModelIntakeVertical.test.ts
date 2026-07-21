import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { IfcOpenShellIdsValidationProvider } from "../../requirements/ifcOpenShellIdsValidationProvider.ts";
import { extractIfcModelFromFile } from "../../requirements/ifcFileExtraction.ts";

const demo = path.resolve(process.cwd(), "../documentation/demo-inputs/model-intake");
const provider = new IfcOpenShellIdsValidationProvider();
const hash = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const metadata = (file: string) => ({ artifactId: null, artifactUuid: crypto.randomUUID(), familyKey: "temporary-upload",
    version: "unknown", sha256: hash(file), absolutePath: file });

test("researcher-selected multipart inputs are genuinely extracted and executed: changing only IDS changes hash, requirements, and findings", async () => {
    const ifc = path.join(demo, "model-v1.ifc");
    const idsPass = path.join(demo, "ids-reference-required.ids");
    const idsFail = path.join(demo, "ids-reference-and-extra-property.ids");
    const extracted = await extractIfcModelFromFile(ifc);
    assert.equal(extracted.schema, "IFC4");
    assert.equal(extracted.inventoryData["0V1SpaceSynthetic001"]?.psets?.Pset_SpaceCommon?.Reference, "R-101");
    const visiblePass = await provider.validateProfile(metadata(idsPass), crypto.randomUUID(), 30000);
    const visibleFail = await provider.validateProfile(metadata(idsFail), crypto.randomUUID(), 30000);
    assert.notEqual(visiblePass.profileSha256, visibleFail.profileSha256);
    assert.ok(visiblePass.requirements?.some((item) => item.requires === "Tag"));
    assert.ok(visibleFail.requirements?.some((item) => item.requires === "Pset_SpaceCommon.Department"));
    const pass = await provider.validate({ ifcPath: ifc, profile: metadata(idsPass), correlationId: crypto.randomUUID(), timeoutMs: 30000 });
    const fail = await provider.validate({ ifcPath: ifc, profile: metadata(idsFail), correlationId: crypto.randomUUID(), timeoutMs: 30000 });
    assert.equal(pass.conforms, true); assert.equal(fail.conforms, false);
    assert.ok(fail.findings.some((item) => item.propertyName === "Department" && item.status === "fail"));
    assert.equal(pass.fileSha256, fail.fileSha256, "the IFC remained unchanged while IDS changed");
});

test("V1/V2 prove version-specific GUID change while preserving the candidate Reference and Tag identities", async () => {
    const v1 = await extractIfcModelFromFile(path.join(demo, "model-v1.ifc"));
    const v2 = await extractIfcModelFromFile(path.join(demo, "model-v2-same-identities.ifc"));
    const [guid1, guid2] = [Object.keys(v1.inventoryData)[0]!, Object.keys(v2.inventoryData)[0]!];
    assert.notEqual(guid1, guid2);
    assert.equal(v1.inventoryData[guid1].psets.Pset_SpaceCommon.Reference, v2.inventoryData[guid2].psets.Pset_SpaceCommon.Reference);
    assert.notEqual(v1.inventoryData[guid1].elements[0].guid, v2.inventoryData[guid2].elements[0].guid);
    assert.equal(v1.inventoryData[guid1].elements[0].tag, v2.inventoryData[guid2].elements[0].tag);
    assert.equal(v1.inventoryData[guid1].elements[0].psets.Pset_ManufacturerOccurrence.SerialNumber,
        v2.inventoryData[guid2].elements[0].psets.Pset_ManufacturerOccurrence.SerialNumber);
    assert.notEqual(v1.inventoryData[guid1].spaceName, v2.inventoryData[guid2].spaceName);
});

test("temporary IDS security rejects DTD/entity declarations through the genuine executor and exposes no XML", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oswadt-ids-security-"));
    const file = path.join(dir, "unsafe.ids");
    fs.writeFileSync(file, `<?xml version="1.0"?><!DOCTYPE ids [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><ids>&xxe;</ids>`);
    try {
        await assert.rejects(provider.validateProfile(metadata(file), crypto.randomUUID(), 30000), /could not be completed|rejected/i);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(fs.existsSync(dir), false);
});

test("frontend/backend contract uses real file pickers and multipart, backend hashes/requirements, explicit creation, and no direct Fuseki or Python access", () => {
    const page = fs.readFileSync(path.resolve(process.cwd(), "../front/app/(admin)/dashboard/page.tsx"), "utf8");
    const proxy = fs.readFileSync(path.resolve(process.cwd(), "../front/app/api/model-intake/[...path]/route.ts"), "utf8");
    const route = fs.readFileSync(path.resolve(process.cwd(), "routes/modelIntake.ts"), "utf8");
    const service = fs.readFileSync(path.resolve(process.cwd(), "modelIntake/modelIntakeService.ts"), "utf8");
    assert.equal((page.match(/type="file"/g) ?? []).length, 2);
    assert.match(page, /new FormData/); assert.match(proxy, /request\.formData/); assert.match(route, /upload\.fields/);
    assert.match(page, /serverComputedSha256/); assert.match(page, /profile\.requirements/);
    assert.match(page, /Validate and preview/); assert.match(page, /Create model version/);
    assert.match(service, /ifcGuid: space\.ifc_guid/); assert.match(service, /ifcGuid: asset\.ifc_guid/);
    assert.match(service, /model-version\/\$\{snapshot\.version\.version_uuid\}/);
    assert.doesNotMatch(page + proxy, /3030|SPARQL|IFCOPENSHELL_FLASK|python\/|Fuseki/i);
    assert.doesNotMatch(page, /RDF generated[^\n]*hardcoded/i);
});

test("migration and rollback provide stable UUIDs, one immutable materialisation per version, and never mention reservation tables", () => {
    const forward = fs.readFileSync(path.resolve(process.cwd(), "../database/migrations/2026-07-20_model_intake_semantic_materialisation.sql"), "utf8");
    const rollback = fs.readFileSync(path.resolve(process.cwd(), "../database/migrations/2026-07-20_model_intake_semantic_materialisation_rollback.sql"), "utf8");
    assert.match(forward, /model_uuid/); assert.match(forward, /version_uuid/); assert.match(forward, /model_version_semantic_materialisations/);
    assert.match(forward, /UNIQUE KEY `uq_model_materialisation_version`/); assert.match(forward, /UNIQUE KEY `uq_model_materialisation_graph`/);
    assert.match(rollback, /DROP TABLE IF EXISTS `model_version_semantic_materialisations`/);
    assert.doesNotMatch(forward + rollback, /res_reservations|semantic_sync_operations|CLEAR|DROP\s+(ALL|NAMED|DEFAULT)/i);
});
