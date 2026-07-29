/**
 * ADR-0051 Stage 0B §1: the ORDINARY extraction path (Flask bridge → fetchInventory)
 * must propagate the lossless spaceOccurrences list — not only the controlled CLI
 * extractor. This test exercises fetchInventory against a mocked Flask response and
 * asserts the contract is carried through into ExtractedIfcModel, and that an older
 * bridge (no spaceOccurrences) yields `undefined` (so the write path blocks rather
 * than trusting the GlobalId-collapsed dict).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchInventory } from "../../services/preprocessService.ts";

const realFetch = globalThis.fetch;
process.env.IFCOPENSHELL_FLASK_API_ROUTE ??= "http://flask.test/api";

beforeEach(() => { /* per-test fetch set below */ });
afterEach(() => { (globalThis as any).fetch = realFetch; });

const GA = "3VKKG6_QDBqgUlHMH5Q4EB";

test("fetchInventory propagates the lossless spaceOccurrences from the ordinary Flask bridge", async () => {
    const occurrences = [
        { entityId: 10, guid: GA, name: "A1", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-1" } } },
        { entityId: 11, guid: GA, name: "A2", longName: null, psets: { Pset_SpaceCommon: { Reference: "R-2" } } },
    ];
    let sentBody: string | undefined;
    (globalThis as any).fetch = async (_url: string, init?: any) => {
        sentBody = init?.body;
        return { ok: true, json: async () => ({
            data: { [GA]: { spaceGuid: GA, spaceName: "A", elements: [] } },
            spaceOccurrences: occurrences,
            schema: "IFC4",
            uncontainedProxies: [],
        }) };
    };
    const extracted = await fetchInventory(1, 2);
    // The Node side sends only an opaque numeric version id — never a URL/path — so the
    // Python service constructs the authenticated download URL itself.
    assert.equal(sentBody, "versionId=2");
    assert.ok(Array.isArray(extracted.spaceOccurrences));
    assert.equal(extracted.spaceOccurrences!.length, 2, "both occurrences of the duplicate GlobalId are carried through");
    assert.deepEqual(extracted.spaceOccurrences!.map((o) => o.entityId), [10, 11]);
    assert.equal(extracted.schema, "IFC4");
});

test("fetchInventory leaves spaceOccurrences undefined when an older bridge omits it (write path then blocks)", async () => {
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({
        data: { [GA]: { spaceGuid: GA, spaceName: "A", elements: [] } },
        schema: "IFC4",
    }) });
    const extracted = await fetchInventory(1);
    assert.equal(extracted.spaceOccurrences, undefined);
});

test("fetchInventory ignores a non-array spaceOccurrences (never a false duplicate-safety claim)", async () => {
    (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({
        data: { [GA]: { spaceGuid: GA, spaceName: "A", elements: [] } },
        spaceOccurrences: "corrupt",
    }) });
    const extracted = await fetchInventory(1);
    assert.equal(extracted.spaceOccurrences, undefined);
});
