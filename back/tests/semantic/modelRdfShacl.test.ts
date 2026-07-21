import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateMappingProfile } from "../../modelIntake/mappingProfileService.ts";
import { buildMinimalRdf } from "../../modelIntake/rdfMaterialiser.ts";
import { PyShaclValidationProvider } from "../../semanticValidation/pyShaclValidationProvider.ts";

const artifacts = path.resolve(process.cwd(), "../semantic/artifacts");
const mapping = validateMappingProfile(JSON.parse(fs.readFileSync(path.join(artifacts,
    "runtime/oswadt-ifc4-minimal-rdf-mapping/1.0.0/oswadt-ifc4-minimal-rdf-mapping-v1.json"), "utf8")));
const governedShapes = fs.readFileSync(path.join(artifacts,
    "runtime/oswadt-model-rdf-structural-shapes/1.0.0/oswadt-model-rdf-structural-shapes-v1.ttl"), "utf8");
const temporaryShapes = fs.readFileSync(path.resolve(process.cwd(),
    "../documentation/demo-inputs/shacl/temporary-manifestation-description-required.ttl"), "utf8");
const provider = new PyShaclValidationProvider();

async function modelRdf() {
    return buildMinimalRdf({ baseUri: "http://oswadt.test/id", mapping,
        mappingArtifactUri: "http://oswadt.test/id/semantic-artifact/11111111-1111-4111-8111-111111111111",
        idsProfileUri: "http://oswadt.test/id/semantic-artifact/22222222-2222-4222-8222-222222222222",
        idsProfileVersion: "1.0.0", runUuid: "33333333-3333-4333-8333-333333333333",
        materialisationUuid: "44444444-4444-4444-8444-444444444444",
        logicalModelUuid: "55555555-5555-4555-8555-555555555555",
        modelVersionUuid: "66666666-6666-4666-8666-666666666666", versionNumber: 1,
        filename: "model-v1.ifc", fileSha256: "a".repeat(64), ifcSchema: "IFC4",
        generatedAt: "2026-07-20T12:00:00.000Z",
        spaces: [{ persistentUuid: "77777777-7777-4777-8777-777777777777", reference: "R-101", label: "Synthetic room",
            ifcGuid: "space-guid-v1", ifcClass: "IfcSpace", storey: "Level 1",
            persistentUri: "http://oswadt.test/id/space/77777777-7777-4777-8777-777777777777",
            manifestationUri: "http://oswadt.test/id/model-version/66666666-6666-4666-8666-666666666666/manifestation/space-guid-v1" }],
        assets: [{ persistentUuid: "88888888-8888-4888-8888-888888888888", tag: "EQP-DEMO-001",
            serialNumber: "SYN-001", manufacturer: "Synthetic", ifcGuid: "asset-guid-v1",
            ifcClass: "IfcFurnishingElement", containingSpace: "R-101",
            persistentUri: "http://oswadt.test/id/asset/88888888-8888-4888-8888-888888888888",
            manifestationUri: "http://oswadt.test/id/model-version/66666666-6666-4666-8666-666666666666/manifestation/asset-guid-v1" }],
    });
}

function validate(dataTurtle: string, shapesTurtle: string, correlationId: string) {
    return provider.validate({ dataTurtle, shapesTurtle, inference: "none", advanced: true,
        metaShacl: true, timeoutMs: 30_000, correlationId });
}

test("real model-version RDF conforms to the governed structural shape set and its backend hash matches Turtle", async () => {
    const rdf = await modelRdf();
    const report = await validate(rdf.turtle, governedShapes, "model-governed-pass");
    assert.equal(report.conforms, true);
    assert.equal(report.resultCount, 0);
    assert.equal(rdf.turtleSha256, crypto.createHash("sha256").update(rdf.turtle).digest("hex"));
    assert.ok(report.constraints.length >= 20);
});

test("changing only to temporary shapes changes the hash and produces explainable manifestation violations", async () => {
    const rdf = await modelRdf();
    const governed = await validate(rdf.turtle, governedShapes, "model-governed-control");
    const temporary = await validate(rdf.turtle, temporaryShapes, "model-temporary-fail");
    assert.equal(governed.conforms, true);
    assert.equal(temporary.conforms, false);
    assert.equal(temporary.resultCount, 2);
    assert.notEqual(crypto.createHash("sha256").update(governedShapes).digest("hex"),
        crypto.createHash("sha256").update(temporaryShapes).digest("hex"));
    assert.ok(temporary.results.every((row) => row.focusNode?.includes("/manifestation/")
        && row.resultPath === "http://purl.org/dc/terms/description"
        && row.message?.includes("description")));
});
