import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Parser } from "n3";
import { validateMappingProfile } from "../../modelIntake/mappingProfileService.ts";
import { buildMinimalRdf } from "../../modelIntake/rdfMaterialiser.ts";

const mapping = validateMappingProfile(JSON.parse(fs.readFileSync(path.resolve("../semantic/artifacts/runtime/oswadt-ifc4-minimal-rdf-mapping/1.0.0/oswadt-ifc4-minimal-rdf-mapping-v1.json"), "utf8")));

test("backend RDF preview is parseable Turtle with real counts, provenance, persistent resources, and distinct manifestations", async () => {
    const rdf = await buildMinimalRdf({ baseUri: "http://oswadt.test/id", mapping,
        mappingArtifactUri: "http://oswadt.test/id/semantic-artifact/11111111-1111-4111-8111-111111111111",
        idsProfileUri: "http://oswadt.test/id/temporary-ids-profile/" + "a".repeat(64), idsProfileVersion: "1.0.0",
        runUuid: "22222222-2222-4222-8222-222222222222", materialisationUuid: "33333333-3333-4333-8333-333333333333",
        logicalModelUuid: "44444444-4444-4444-8444-444444444444", modelVersionUuid: "55555555-5555-4555-8555-555555555555", versionNumber: 2,
        filename: "synthetic.ifc", fileSha256: "b".repeat(64), ifcSchema: "IFC4", generatedAt: "2026-07-20T12:00:00.000Z",
        spaces: [{ persistentUuid: "66666666-6666-4666-8666-666666666666", reference: "R-101", label: "Room", ifcGuid: "space-guid-v2",
            ifcClass: "IfcSpace", storey: "Level 2", persistentUri: "http://oswadt.test/id/space/66666666-6666-4666-8666-666666666666",
            manifestationUri: "http://oswadt.test/id/model-version/55555555-5555-4555-8555-555555555555/manifestation/space-guid-v2" }],
        assets: [{ persistentUuid: "77777777-7777-4777-8777-777777777777", tag: "EQP-DEMO-001", serialNumber: "SYN-SERIAL-001",
            manufacturer: "Synthetic Lab Equipment", ifcGuid: "asset-guid-v2", ifcClass: "IfcFurnishingElement", containingSpace: "R-101",
            persistentUri: "http://oswadt.test/id/asset/77777777-7777-4777-8777-777777777777",
            manifestationUri: "http://oswadt.test/id/model-version/55555555-5555-4555-8555-555555555555/manifestation/asset-guid-v2" }],
    });
    const parsed = new Parser().parse(rdf.turtle);
    assert.equal(parsed.length, rdf.tripleCount);
    assert.equal(rdf.spaceCount, 1); assert.equal(rdf.assetCount, 1); assert.equal(rdf.manifestationCount, 2);
    assert.match(rdf.turtle, /prov:specializationOf/);
    assert.match(rdf.turtle, /R-101/); assert.match(rdf.turtle, /EQP-DEMO-001/); assert.match(rdf.turtle, /space-guid-v2/);
    assert.doesNotMatch(rdf.turtle, /geometry|ifcowl|reservation|actor/i);
    assert.equal(rdf.turtleSha256.length, 64);
});

test("preview identity remains visibly candidate and never invents a final UUID", async () => {
    const rdf = await buildMinimalRdf({ baseUri: "http://oswadt.test/id", mapping,
        mappingArtifactUri: "http://oswadt.test/id/mapping", idsProfileUri: "http://oswadt.test/id/ids", idsProfileVersion: "1",
        runUuid: "88888888-8888-4888-8888-888888888888", materialisationUuid: "88888888-8888-4888-8888-888888888888",
        logicalModelUuid: null, modelVersionUuid: null, versionNumber: null, filename: "preview.ifc", fileSha256: "c".repeat(64), ifcSchema: "IFC4",
        generatedAt: "2026-07-20T12:00:00.000Z", spaces: [], assets: [] });
    assert.match(rdf.turtle, /candidate/);
    assert.ok(rdf.warnings.some((warning) => warning.includes("candidate")));
});
