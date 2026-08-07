/**
 * ADR-0052 §F — a space is never a reservable resource. Proves at the data layer:
 *  - reservationDatabase.createReservation rejects a LEGACY asset whose asset_type is
 *    'space' BEFORE any conflict check or INSERT (a direct space reservation is refused);
 *  - equipment/tool assets continue to reserve normally;
 *  - the student discovery query and the reservable-id resolver restrict to
 *    asset_type IN ('equipment','tool') and expose location as inventoryCode/longName.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();

const providers = await import("../../policies/policyProvider.ts");
const { default: reservationDb } = await import("../../utils/reservationDatabase.ts");
const { default: persistentAssetDb } = await import("../../utils/persistentAssetDatabase.ts");
const { default: nonModelledDb } = await import("../../utils/nonModelledAssetDatabase.ts");

beforeEach(() => {
    fakeConnection.reset();
    providers.resetPolicyProviders();
});

function allowAll() {
    providers.setReservationRequestValidator({
        evaluate: async () => ({ decision: "allow", reasons: [], evaluatorId: "mock", evaluatedAt: new Date().toISOString() }),
        validate: async () => ({ decision: "allow", reasons: [], evaluatorId: "mock", evaluatedAt: new Date().toISOString() }),
    } as any);
}

const start = new Date(Date.now() + 3_600_000);
const end = new Date(Date.now() + 7_200_000);

test("direct reservation of a LEGACY space asset is rejected before any conflict check or INSERT", async () => {
    allowAll();
    respond([
        [/SELECT lifecycle_status[\s\S]*FROM assets WHERE id = :assetId[\s\S]*FOR UPDATE/i,
            [[{ lifecycle_status: "active", source: "ifc", reservable: 1, asset_uuid: "u-1", asset_type: "space" }]]],
    ]);

    await assert.rejects(reservationDb.createReservation(1, "actor1", start, end),
        /space is not a reservable resource/i);

    assert.equal(fakeConnection.callsMatching(/status IN \('approved','in_use','no_show'\)/i).length, 0, "no conflict check");
    assert.equal(fakeConnection.callsMatching(/INSERT INTO res_reservations/i).length, 0, "no reservation inserted");
});

test("equipment asset reserves normally (asset_type='equipment' passes the space guard)", async () => {
    allowAll();
    respond([
        [/SELECT lifecycle_status[\s\S]*FROM assets WHERE id = :assetId[\s\S]*FOR UPDATE/i,
            [[{ lifecycle_status: "active", source: "ifc", reservable: 1, asset_uuid: "u-2", asset_type: "equipment" }]]],
        [/SELECT COUNT\(\*\) as count/i, [[{ count: 0 }]]],
        [/INSERT INTO res_reservations/i, [{ insertId: 501 }]],
    ]);

    const id = await reservationDb.createReservation(2, "actor1", start, end);
    assert.equal(id, 501);
    const insert = fakeConnection.callsMatching(/INSERT INTO res_reservations/i)[0]!;
    assert.match(insert.sql, /'pending'/);
});

test("resolveReservableAssetId restricts to equipment/tool", async () => {
    respond([[/SELECT id FROM assets[\s\S]*asset_uuid = :persistentAssetId/i, [[]]]]);
    const resolved = await persistentAssetDb.resolveReservableAssetId("uuid-space");
    assert.equal(resolved, null);
    const q = fakeConnection.callsMatching(/asset_uuid = :persistentAssetId/i)[0]!;
    assert.match(q.sql, /asset_type IN \('equipment', 'tool'\)/i, "space assets are never resolvable");
});

test("student discovery excludes spaces and exposes inventoryCode/longName location", async () => {
    respond([[/WITH current_bindings[\s\S]*FROM assets a/i, [[{
        asset_uuid: "u-eq", name: "Mesa", asset_code: "EQP-1", representation_kind: "modelled",
        model_line_id: 1, model_line_name: "M", linked_model_id: 9,
        location_space_id: 7, location_space_uuid: "s-7", location_inventory_code: "R-101", location_long_name: "Sala 101",
    }]]]]);

    const items = await nonModelledDb.listStudentReservableAssets(null);
    const q = fakeConnection.callsMatching(/FROM assets a/i)[0]!;
    assert.match(q.sql, /asset_type IN \('equipment', 'tool'\)/i, "spaces are never listed as resources");
    assert.deepEqual(items[0].location, { spaceId: 7, spaceUuid: "s-7", inventoryCode: "R-101", longName: "Sala 101" });
});
