import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractIfcModelFromFile } from "../../requirements/ifcFileExtraction.ts";
import { IfcOpenShellIdsValidationProvider } from "../../requirements/ifcOpenShellIdsValidationProvider.ts";
import { validateMappingProfile } from "../../modelIntake/mappingProfileService.ts";
import { buildMinimalRdf } from "../../modelIntake/rdfMaterialiser.ts";
import { PyShaclValidationProvider } from "../../semanticValidation/pyShaclValidationProvider.ts";

const repository = path.resolve(process.cwd(), "..");
const demo = path.join(repository, "documentation/demo-inputs/model-intake");
const ifcPath = path.join(demo, "model-v1.ifc");
const idsPath = path.join(demo, "ids-reference-required.ids");
const hashFile = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("controlled vertical flow executes selected IFC + IDS, real RDF, governed pass, and temporary fail", async () => {
    const extracted = await extractIfcModelFromFile(ifcPath);
    const idsMetadata = { artifactId: null, artifactUuid: "11111111-1111-4111-8111-111111111111",
        familyKey: "temporary-test-profile", version: "unknown", sha256: hashFile(idsPath), absolutePath: idsPath };
    const ids = await new IfcOpenShellIdsValidationProvider().validate({ ifcPath, profile: idsMetadata,
        correlationId: "22222222-2222-4222-8222-222222222222", timeoutMs: 30_000 });
    assert.equal(ids.conforms, true);

    const mapping = validateMappingProfile(JSON.parse(fs.readFileSync(path.join(repository,
        "semantic/artifacts/runtime/oswadt-ifc4-minimal-rdf-mapping/1.0.0/oswadt-ifc4-minimal-rdf-mapping-v1.json"), "utf8")));
    const [spaceGuid, space] = Object.entries(extracted.inventoryData)[0]!;
    const element = space.elements[0]!;
    const rdf = await buildMinimalRdf({ baseUri: "http://oswadt.test/id", mapping,
        mappingArtifactUri: "http://oswadt.test/id/semantic-artifact/33333333-3333-4333-8333-333333333333",
        idsProfileUri: `http://oswadt.test/id/temporary-ids-profile/${idsMetadata.sha256}`,
        idsProfileVersion: "1.0.0", runUuid: "44444444-4444-4444-8444-444444444444",
        materialisationUuid: "55555555-5555-4555-8555-555555555555",
        logicalModelUuid: "66666666-6666-4666-8666-666666666666",
        modelVersionUuid: "77777777-7777-4777-8777-777777777777", versionNumber: 1,
        filename: "model-v1.ifc", fileSha256: hashFile(ifcPath), ifcSchema: extracted.schema,
        generatedAt: "2026-07-20T12:00:00.000Z",
        spaces: [{ persistentUuid: "88888888-8888-4888-8888-888888888888",
            reference: String(space.psets.Pset_SpaceCommon.Reference), label: space.spaceName ?? null,
            ifcGuid: spaceGuid, ifcClass: "IfcSpace", storey: space.storeyName ?? null,
            persistentUri: "http://oswadt.test/id/space/88888888-8888-4888-8888-888888888888",
            manifestationUri: `http://oswadt.test/id/model-version/77777777-7777-4777-8777-777777777777/manifestation/${spaceGuid}` }],
        assets: [{ persistentUuid: "99999999-9999-4999-8999-999999999999", tag: String(element.tag),
            serialNumber: String(element.psets.Pset_ManufacturerOccurrence?.SerialNumber ?? "SYN-001"),
            manufacturer: String(element.psets.Pset_ManufacturerOccurrence?.Manufacturer ?? "Synthetic"),
            ifcGuid: element.guid, ifcClass: element.type, containingSpace: String(space.psets.Pset_SpaceCommon.Reference),
            persistentUri: "http://oswadt.test/id/asset/99999999-9999-4999-8999-999999999999",
            manifestationUri: `http://oswadt.test/id/model-version/77777777-7777-4777-8777-777777777777/manifestation/${element.guid}` }],
    });
    assert.equal(rdf.turtleSha256, crypto.createHash("sha256").update(rdf.turtle).digest("hex"));

    const governedShapes = fs.readFileSync(path.join(repository,
        "semantic/artifacts/runtime/oswadt-model-rdf-structural-shapes/1.0.0/oswadt-model-rdf-structural-shapes-v1.ttl"), "utf8");
    const temporaryShapes = fs.readFileSync(path.join(repository,
        "documentation/demo-inputs/shacl/temporary-manifestation-description-required.ttl"), "utf8");
    const shacl = new PyShaclValidationProvider();
    const base = { dataTurtle: rdf.turtle, inference: "none" as const, advanced: true, metaShacl: true, timeoutMs: 30_000 };
    const governed = await shacl.validate({ ...base, shapesTurtle: governedShapes, correlationId: "governed-pass" });
    const temporary = await shacl.validate({ ...base, shapesTurtle: temporaryShapes, correlationId: "temporary-fail" });
    assert.equal(governed.conforms, true); assert.equal(governed.resultCount, 0);
    assert.equal(temporary.conforms, false); assert.equal(temporary.resultCount, 2);
    assert.ok(temporary.results.every((row) => row.focusNode && row.resultPath && row.message));
});

test("vertical API/frontend contract keeps preview non-persistent and activation/report graph behind governed required validation", () => {
    const intakeRoute = fs.readFileSync(path.join(repository, "back/routes/modelIntake.ts"), "utf8");
    const reportRoute = fs.readFileSync(path.join(repository, "back/routes/semanticValidation.ts"), "utf8");
    const reportProxy = fs.readFileSync(path.join(repository, "front/app/api/semantic-validation/[...path]/route.ts"), "utf8");
    const service = fs.readFileSync(path.join(repository, "back/modelIntake/semanticMaterialisationService.ts"), "utf8");
    const page = fs.readFileSync(path.join(repository, "front/app/(admin)/dashboard/page.tsx"), "utf8");
    assert.match(intakeRoute, /shacl\/inspect/); assert.match(intakeRoute, /shacl\/validate/);
    assert.match(intakeRoute, /finally \{ removeUploadedFiles\(req\); \}/);
    assert.doesNotMatch(intakeRoute.slice(intakeRoute.indexOf("/shacl/validate"), intakeRoute.indexOf("/preflight")), /putGraph|persistModelReport|createVersion/);
    assert.match(service, /if \(!shaclReport\.conforms && validationConfig\.mode === "required"\)/);
    assert.ok(service.indexOf("validation.execute") < service.indexOf("client.putGraph"));
    assert.ok(service.indexOf("persistModelReport") < service.lastIndexOf("markVerified"));
    assert.match(reportRoute, /report\.ttl/); assert.match(reportRoute, /data\.ttl/);
    assert.match(reportProxy, /BASE_API_URL.*semantic-validation/);
    assert.match(reportProxy, /content-disposition/i);
    assert.equal((page.match(/type="file"/g) ?? []).length, 3);
    assert.match(page, /shapes\.source/); assert.match(page, /governed_active_shapes/);
});
