/**
 * Focused RDF-predicate tests for the IFC4x3 mapping (ADR-0052 §5). Proves the generated
 * Turtle populates project:inventoryCode from Name and project:longName from LongName,
 * never emits the deprecated project:reference for space inventory, keeps exact GlobalId
 * evidence, types spaces as bot:Space (not an application asset), and links equipment
 * location to the persistent space.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildMinimalRdf } from "../../modelIntake/rdfMaterialiser.ts";
import { validateMappingProfile } from "../../modelIntake/mappingProfileService.ts";

const mapping = validateMappingProfile(JSON.parse(fs.readFileSync(path.resolve(process.cwd(),
    "../semantic/artifacts/runtime/oswadt-ifc4-minimal-rdf-mapping/1.1.0/oswadt-ifc4-minimal-rdf-mapping-v1.1.json"), "utf8")));

async function build(spaceLongName: string | null) {
    return buildMinimalRdf({
        baseUri: "http://oswadt.test/id", mapping,
        mappingArtifactUri: "http://oswadt.test/id/mapping", idsProfileUri: "http://oswadt.test/id/ids",
        idsProfileVersion: "1.1.0", runUuid: "11111111-1111-4111-8111-111111111111",
        materialisationUuid: "22222222-2222-4222-8222-222222222222",
        logicalModelUuid: "33333333-3333-4333-8333-333333333333",
        modelVersionUuid: "44444444-4444-4444-8444-444444444444", versionNumber: 1,
        filename: "m.ifc", fileSha256: "a".repeat(64), ifcSchema: "IFC4X3_ADD2",
        generatedAt: "2026-08-06T12:00:00.000Z",
        spaces: [{ persistentUuid: "55555555-5555-4555-8555-555555555555", inventoryCode: "T-101",
            longName: spaceLongName ?? undefined, ifcGuid: "0SPACEGUID0000000000AA", ifcClass: "IfcSpace",
            storey: null, persistentUri: "http://oswadt.test/id/space/55555555-5555-4555-8555-555555555555",
            manifestationUri: "http://oswadt.test/id/model-version/44444444-4444-4444-8444-444444444444/manifestation/space" } as any],
        assets: [{ persistentUuid: "66666666-6666-4666-8666-666666666666", tag: "EQP-1", serialNumber: null,
            manufacturer: null, ifcGuid: "0ASSETGUID0000000000AA", ifcClass: "IfcFurnishingElement",
            containingSpace: "T-101",
            containingSpacePersistentUri: "http://oswadt.test/id/space/55555555-5555-4555-8555-555555555555",
            persistentUri: "http://oswadt.test/id/asset/66666666-6666-4666-8666-666666666666",
            manifestationUri: "http://oswadt.test/id/model-version/44444444-4444-4444-8444-444444444444/manifestation/asset" } as any],
    });
}

test("inventoryCode is populated from Name; no project:reference for space inventory", async () => {
    const rdf = await build("Laboratory 101");
    assert.match(rdf.turtle, /inventoryCode\s+"T-101"/, "inventoryCode from Name");
    assert.doesNotMatch(rdf.turtle, /project:reference|:reference\s+"/, "no reference predicate");
});

test("longName is populated from LongName and omitted when absent", async () => {
    const withLong = await build("Laboratory 101");
    assert.match(withLong.turtle, /longName\s+"Laboratory 101"/, "longName from LongName");
    const withoutLong = await build(null);
    assert.doesNotMatch(withoutLong.turtle, /longName\s+"/, "longName omitted when absent");
    assert.match(withoutLong.turtle, /inventoryCode\s+"T-101"/, "inventoryCode still present");
});

test("exact GlobalId evidence exists and spaces are typed bot:Space, never an application asset", async () => {
    const rdf = await build("Laboratory 101");
    assert.match(rdf.turtle, /0SPACEGUID0000000000AA/, "exact space GlobalId evidence");
    assert.match(rdf.turtle, /bot:Space/, "space typed as bot:Space");
    // The space subject must not be typed as the furnishing/asset class.
    assert.doesNotMatch(rdf.turtle, /space\/55555555[\s\S]{0,120}beo:Furnishing/, "space is not an asset");
});

test("equipment manifestation is linked to its containing persistent space", async () => {
    const rdf = await build("Laboratory 101");
    assert.match(rdf.turtle, /containedInSpace/, "equipment location predicate present");
    assert.match(rdf.turtle, /space\/55555555-5555-4555-8555-555555555555/, "location points at the persistent space");
});
