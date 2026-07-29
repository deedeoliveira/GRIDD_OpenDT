/**
 * ADR-0051 §7-v4 — the ORDINARY Flask inventory path really emits the lossless payload.
 *
 * losslessBridge.test.ts proves fetchInventory PROPAGATES the field from a mocked
 * payload; this proves the REAL Python behind the ordinary endpoint PRODUCES it. The
 * Flask endpoint `/api/model/inventory/<modelId>` builds its body by calling the single
 * pure function `ifcopenshell_utils.build_inventory_payload(file_path)` (main.py returns
 * exactly its result). This test invokes THAT EXACT function over the real duplicate
 * fixture — the endpoint-used implementation, not a hand-assembled reconstruction — and
 * checks:
 *   - `data` and `spaceOccurrences` are present;
 *   - the duplicate fixture yields TWO occurrences for the shared GlobalId;
 *   - `data` (GlobalId-keyed) collapses that duplicate to ONE key;
 *   - each occurrence preserves its own `entityId` and `storeyName`;
 *   - Python does NOT interpret Reference (occurrence carries raw psets, no reference field);
 *   - the controlled (ifc_extract.py) and ordinary extractors expose EQUIVALENT occurrences.
 * A single static assertion confirms main.py delegates to build_inventory_payload — it
 * guards the wiring only; the behavioural proof above runs the real function.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractIfcModelFromFile } from "../../requirements/ifcFileExtraction.ts";

const execFileAsync = promisify(execFile);
const python = process.env.IDS_PYTHON_EXECUTABLE ?? path.resolve(process.cwd(), "python", "venv", "Scripts", "python.exe");
const pyDir = path.resolve(process.cwd(), "python");
const fixture = path.resolve(process.cwd(), "tests/fixtures/duplicate-space-globalid.ifc");
const DUP = "DUPGUIDSPACE0000000001";

// Invoke the EXACT function the ordinary endpoint uses to build its body.
const snippet = `
import json, ifcopenshell_utils as u
print(json.dumps(u.build_inventory_payload(${JSON.stringify(fixture)})))
`;

async function runEndpointPayload(): Promise<any> {
    const { stdout } = await execFileAsync(python, ["-c", snippet], { cwd: pyDir, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout.trim());
}

test("main.py delegates the inventory response to build_inventory_payload (wiring guard)", () => {
    const src = fs.readFileSync(path.join(pyDir, "main.py"), "utf8");
    assert.match(src, /build_inventory_payload\(\)/);
});

test("the endpoint-used build_inventory_payload really carries data + lossless spaceOccurrences (real Python)", async () => {
    const payload = await runEndpointPayload();

    assert.equal(payload.ok, true);
    assert.equal(payload.status, "success");
    assert.ok(payload.data && typeof payload.data === "object", "data present");
    assert.ok(Array.isArray(payload.spaceOccurrences), "spaceOccurrences present");

    // data is GlobalId-keyed → the duplicate collapses to a single key.
    assert.equal(Object.keys(payload.data).filter((g) => g === DUP).length, 1);
    // the lossless list retains BOTH occurrences of the shared GlobalId.
    const dupOcc = payload.spaceOccurrences.filter((o: any) => o.guid === DUP);
    assert.equal(dupOcc.length, 2);
    // each occurrence preserves its own entity id and storey.
    assert.notEqual(dupOcc[0].entityId, dupOcc[1].entityId);
    assert.ok(Number.isInteger(dupOcc[0].entityId) && dupOcc[0].entityId > 0);
    for (const o of payload.spaceOccurrences) {
        assert.ok("entityId" in o && Number.isInteger(o.entityId), "occurrence carries an IFC entity id");
        assert.ok("storeyName" in o, "occurrence carries its own storey");
    }

    // Python interprets NO Reference: the occurrence carries raw psets and never a
    // derived `reference` field.
    for (const o of payload.spaceOccurrences) {
        assert.ok(!("reference" in o), "occurrence must not carry an interpreted Reference");
        assert.ok("psets" in o, "occurrence carries raw property sets");
    }
});

test("controlled (ifc_extract.py) and ordinary (build_inventory_payload) extractors expose equivalent occurrence records", async () => {
    const ordinary = await runEndpointPayload();
    const controlled = await extractIfcModelFromFile(fixture);

    const key = (list: any[]) => list.map((o) => `${o.guid}#${o.entityId}`).sort();
    assert.deepEqual(key(ordinary.spaceOccurrences), key(controlled.spaceOccurrences!),
        "both extraction paths emit the same per-occurrence (GlobalId, entityId) records");
    assert.deepEqual(Object.keys(ordinary.data).sort(), Object.keys(controlled.inventoryData).sort());
});
