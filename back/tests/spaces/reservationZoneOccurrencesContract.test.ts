/**
 * RZ-1 — the additive `reservationZoneOccurrences` field really flows through the
 * ORDINARY Python↔TS boundary the way `ordinaryFlaskResponse.test.ts` proves
 * `spaceOccurrences` does: this test invokes the REAL production function
 * `ifcopenshell_utils.build_inventory_payload(file_path)` (the exact function the
 * Flask endpoint `/api/model/inventory/<modelId>` calls, per main.py) over the real
 * RZ-1 synthetic fixture, and checks the payload the Node bridge (`fetchInventory` in
 * services/preprocessService.ts) receives:
 *   - `reservationZoneOccurrences` is present and is an array of the documented shape;
 *   - it is never treated as an IfcSpace (no `guid`/`longName`/`storeyName` keys, and
 *     it is a DIFFERENT array from `spaceOccurrences`);
 *   - it is never treated as an asset (no `tag`/`objectType`/`psets` keys);
 *   - existing fields (`data`, `spaceOccurrences`, `schema`, `ok`) are unchanged
 *     alongside it (additive only);
 *   - a model with zero ReservationZones still yields `reservationZoneOccurrences: []`
 *     (never missing/null), so this addition never changes acceptance behaviour.
 * This does not persist anything and does not run the field through model-intake
 * acceptance/governance — RZ-1 has no such consumer yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const python = process.env.IDS_PYTHON_EXECUTABLE ?? path.resolve(process.cwd(), "python", "venv", "Scripts", "python.exe");
const pyDir = path.resolve(process.cwd(), "python");
const scenariosFixture = path.resolve(process.cwd(), "tests/fixtures/ifc4x3-reservation-zone-scenarios.ifc");
const baselineFixture = path.resolve(process.cwd(), "tests/fixtures/ifc4x3-three-space-baseline.ifc");

async function runPayload(fixturePath: string): Promise<any> {
    const snippet = `
import json, ifcopenshell_utils as u
print(json.dumps(u.build_inventory_payload(${JSON.stringify(fixturePath)})))
`;
    const { stdout } = await execFileAsync(python, ["-c", snippet], { cwd: pyDir, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout.trim());
}

test("the real build_inventory_payload carries reservationZoneOccurrences additively, alongside unchanged existing fields", async () => {
    const payload = await runPayload(scenariosFixture);

    assert.equal(payload.ok, true);
    assert.equal(payload.status, "success");
    assert.ok(payload.data && typeof payload.data === "object", "existing data field present");
    assert.ok(Array.isArray(payload.spaceOccurrences), "existing spaceOccurrences field present");
    assert.ok(typeof payload.schema === "string", "existing schema field present");

    assert.ok(Array.isArray(payload.reservationZoneOccurrences), "reservationZoneOccurrences present");
    assert.equal(payload.reservationZoneOccurrences.length, 4, "4 RESERVATION candidates in the scenarios fixture");

    for (const occ of payload.reservationZoneOccurrences) {
        assert.equal(occ.ifcClass, "IfcSpatialZone");
        assert.equal(occ.predefinedType, "RESERVATION");
        assert.ok(Number.isInteger(occ.entityId) && occ.entityId > 0, "entityId is a positive int");
        assert.ok(typeof occ.globalId === "string" && occ.globalId.length > 0, "globalId present");
        assert.ok(occ.name === null || typeof occ.name === "string", "name is string or null");
        assert.ok(Array.isArray(occ.referencedSpaceGlobalIds), "referencedSpaceGlobalIds is an array");

        // Never mistaken for an IfcSpace occurrence.
        assert.ok(!("guid" in occ), "must not carry IfcSpace's guid key");
        assert.ok(!("longName" in occ), "must not carry IfcSpace's longName key");
        assert.ok(!("storeyName" in occ), "must not carry IfcSpace's storeyName key");
        // Never mistaken for an equipment/element entry.
        assert.ok(!("tag" in occ), "must not carry equipment tag key");
        assert.ok(!("objectType" in occ), "must not carry equipment objectType key");
        assert.ok(!("psets" in occ), "must not carry raw psets (RZ-1 contract is exactly 6 fields)");

        assert.deepEqual(Object.keys(occ).sort(), [
            "entityId", "globalId", "ifcClass", "name", "predefinedType", "referencedSpaceGlobalIds",
        ]);
    }

    // Distinct array from spaceOccurrences — never folded into it.
    assert.notDeepEqual(payload.reservationZoneOccurrences, payload.spaceOccurrences);
});

test("a model with zero ReservationZones still yields reservationZoneOccurrences: [] (additive, never missing/null, never a rejection)", async () => {
    const payload = await runPayload(baselineFixture);

    assert.equal(payload.ok, true);
    assert.deepEqual(payload.reservationZoneOccurrences, []);
    // Existing baseline space extraction is unaffected by the addition.
    assert.equal(payload.spaceOccurrences.length, 3);
});
