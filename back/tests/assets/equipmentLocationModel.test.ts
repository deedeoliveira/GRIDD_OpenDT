/**
 * ADR-0052 §F location model (bounded correction batch). Proves, executably, that:
 *  - modelled equipment location is version-specific in asset_bindings.space_id, NEVER on
 *    the persistent asset row (no assets.space_id is written);
 *  - two distinct equipment assets can occupy the SAME space (no uniqueness collision);
 *  - across versions the SAME persistent asset id is reused while each version's binding
 *    records its own space (equipment "moves"); the current location is the current
 *    version's binding, historical bindings are never rewritten;
 *  - the API exposes location as inventoryCode/longName from the GlobalId-matched space.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeMySQL, fakeConnection, respond } from "../helpers/fakeDb.ts";

installFakeMySQL();

const { persistAssetsForVersion } = await import("../../services/assetInventoryService.ts");
const persistentAssetDb = (await import("../../utils/persistentAssetDatabase.ts")).default;
const providers = await import("../../policies/policyProvider.ts");
const identityProvider = await import("../../identity/assetIdentityProvider.ts");
const classifierProvider = await import("../../classification/equipmentClassifierProvider.ts");

beforeEach(() => {
    fakeConnection.reset();
    providers.resetPolicyProviders();
    identityProvider.resetAssetIdentityResolver();
    classifierProvider.resetEquipmentClassifier();
    delete process.env.ASSET_IDENTITY_PROVIDER;
});

function baseRoutes(overrides: [RegExp, any][] = []): [RegExp, any][] {
    return [
        ...overrides,
        [/FROM assets[\s\S]*asset_code = :tag/i, [[]]],
        [/FROM assets[\s\S]*serial_number = :serial/i, [[]]],
        [/INSERT INTO assets/i, (() => { let id = 300; return () => [{ insertId: id++ }]; })()],
        [/INSERT INTO asset_bindings/i, [{ insertId: 400 }]],
        [/UPDATE assets/i, [{}]],
    ];
}

/* ============ MULTIPLE EQUIPMENT IN ONE SPACE ============ */

test("two equipment assets in the SAME space: two assets, two bindings, both to that space, no collision, no space asset", async () => {
    respond(baseRoutes());

    const outcome = await persistAssetsForVersion({
        linkedModelId: 10, modelId: 20, modelVersionId: 9,
        inventoryData: {
            "space-T101": {
                spaceGuid: "space-T101", spaceName: "T-101", spaceLongName: "Laboratório 101",
                elements: [
                    { guid: "eq-A", type: "IfcFurniture", name: "Mesa A", tag: "EQP-A", psets: {} },
                    { guid: "eq-B", type: "IfcFurniture", name: "Mesa B", tag: "EQP-B", psets: {} },
                ],
            },
        },
        spaceEntityIdsByGuid: { "space-T101": 100 },
        elementEntityIdsByGuid: { "eq-A": 201, "eq-B": 202 },
        spaceInfoByGuid: { "space-T101": { spaceId: 7, code: "T-101" } },
    } as any);

    const assetInserts = fakeConnection.callsMatching(/INSERT INTO assets/i);
    assert.equal(assetInserts.length, 2, "two distinct equipment assets persist");
    assert.ok(assetInserts.every((c) => c.params.assetType === "equipment"), "never a space asset");
    // No asset insert carries a space_id (persistent row holds no location).
    assert.ok(assetInserts.every((c) => c.params.spaceId == null), "assets.space_id is never written");

    const bindings = fakeConnection.callsMatching(/INSERT INTO asset_bindings/i);
    assert.equal(bindings.length, 2, "two version-specific bindings");
    assert.deepEqual(bindings.map((b) => b.params.spaceId), [7, 7], "BOTH bindings locate to the same space 7");
    assert.deepEqual(outcome.createdAssetIds, [300, 301]);
    assert.equal(outcome.casesCreated, 0);
});

/* ============ VERSIONED EQUIPMENT MOVEMENT ============ */

function versionInput(versionId: number, spaceId: number, spaceCode: string) {
    return {
        linkedModelId: 10, modelId: 20, modelVersionId: versionId,
        inventoryData: {
            [`space-${spaceCode}`]: {
                spaceGuid: `space-${spaceCode}`, spaceName: spaceCode, spaceLongName: `Sala ${spaceCode}`,
                elements: [{ guid: "eq-move", type: "IfcFurniture", name: "Equip E", tag: "EQP-E", psets: {} }],
            },
        },
        spaceEntityIdsByGuid: { [`space-${spaceCode}`]: 100 + versionId },
        elementEntityIdsByGuid: { "eq-move": 500 + versionId },
        spaceInfoByGuid: { [`space-${spaceCode}`]: { spaceId, code: spaceCode } },
    } as any;
}

test("equipment moves across versions: same persistent asset id reused; each version's binding records its own space; no assets.space_id projection", async () => {
    // Version 1: equipment E is NEW, located in T-101 (spaceId 101).
    respond(baseRoutes());
    const v1 = await persistAssetsForVersion(versionInput(1, 101, "T-101"));
    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 1, "v1 creates the asset once");
    const v1Binding = fakeConnection.callsMatching(/INSERT INTO asset_bindings/i)[0]!;
    assert.equal(v1Binding.params.spaceId, 101, "v1 binding records T-101");
    assert.equal(v1Binding.params.assetId, 300);
    const persistentId = v1.createdAssetIds[0];

    // Version 2: the SAME equipment (matched by Tag) now in T-102 (spaceId 102).
    fakeConnection.reset();
    respond(baseRoutes([
        [/FROM assets[\s\S]*asset_code = :tag/i, [[{ id: persistentId, asset_code: "EQP-E", serial_number: null }]]],
    ]));
    await persistAssetsForVersion(versionInput(2, 102, "T-102"));

    assert.equal(fakeConnection.callsMatching(/INSERT INTO assets/i).length, 0,
        "v2 reuses the SAME persistent identity — no new asset");
    const v2Binding = fakeConnection.callsMatching(/INSERT INTO asset_bindings/i)[0]!;
    assert.equal(v2Binding.params.assetId, persistentId, "same persistent asset id");
    assert.equal(v2Binding.params.spaceId, 102, "v2 binding records the NEW space T-102");

    // Historical bindings are never rewritten and there is no mutable assets.space_id update.
    assert.equal(fakeConnection.callsMatching(/UPDATE asset_bindings/i).length, 0, "historical bindings untouched");
    assert.equal(fakeConnection.callsMatching(/UPDATE assets[\s\S]*space_id/i).length, 0, "no assets.space_id projection");
});

/* ============ API LOCATION DERIVATION ============ */

test("current-binding API derives location inventoryCode/longName from the current version's space; history exposes the old space", async () => {
    // Current location: the current-version binding join returns the current space (T-102).
    respond([[/location_inventory_code/i, [[{
        asset_uuid: "u-E", name: "Equip E", asset_code: "EQP-E", representation_kind: "modelled",
        model_line_id: 1, model_line_name: "M", linked_model_id: 9,
        location_space_id: 102, location_space_uuid: "s-102",
        location_inventory_code: "T-102", location_long_name: "Sala T-102",
    }]]]]);
    const current = await persistentAssetDb.getStudentAssetByCurrentBinding(1, "eq-move");
    assert.deepEqual(current!.location, { spaceId: 102, spaceUuid: "s-102", inventoryCode: "T-102", longName: "Sala T-102" });

    // History: the ordered bindings still expose the version-1 space (T-101) — never rewritten.
    fakeConnection.reset();
    respond([[/FROM asset_bindings ab[\s\S]*model_versions v/i, [[
        { asset_id: 300, model_version_id: 1, space_id: 101, version_number: 1 },
        { asset_id: 300, model_version_id: 2, space_id: 102, version_number: 2 },
    ]]]]);
    const history = await persistentAssetDb.getBindingsByAsset(300);
    assert.deepEqual(history.map((b: any) => [b.model_version_id, b.space_id]), [[1, 101], [2, 102]],
        "version-1 binding still locates T-101; version-2 binding locates T-102");
});
