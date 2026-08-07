/**
 * Real pySHACL execution of the governed structural shapes 1.1.0 ModelVersionShape schema
 * constraint (ADR-0052 §A/§H). Proves the tightened, fully-anchored four-identifier
 * alternation `^(IFC4X3|IFC4X3_ADD1|IFC4X3_ADD2|IFC4X3_TC1)$` (never the loose `^IFC4X3`):
 *   - the four accepted IFC4x3 identifiers conform;
 *   - IFC4, IFC2X3, a pre-release RC, an invented ADD3, and fabricated FAKE/ATTACK all
 *     violate;
 *   - a missing or blank project:inventoryCode violates PersistentSpaceShape;
 *   - an absent optional project:longName still conforms.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateMappingProfile } from "../../modelIntake/mappingProfileService.ts";
import { buildMinimalRdf } from "../../modelIntake/rdfMaterialiser.ts";
import { PyShaclValidationProvider } from "../../semanticValidation/pyShaclValidationProvider.ts";

const artifacts = path.resolve(process.cwd(), "../semantic/artifacts");
const mapping = validateMappingProfile(JSON.parse(fs.readFileSync(path.join(artifacts,
    "runtime/oswadt-ifc4-minimal-rdf-mapping/1.1.0/oswadt-ifc4-minimal-rdf-mapping-v1.1.json"), "utf8")));
const governedShapes = fs.readFileSync(path.join(artifacts,
    "runtime/oswadt-model-rdf-structural-shapes/1.1.0/oswadt-model-rdf-structural-shapes-v1.1.ttl"), "utf8");
const provider = new PyShaclValidationProvider();

async function modelRdf(ifcSchema: string, longName: string | null = "Synthetic room") {
    return buildMinimalRdf({ baseUri: "http://oswadt.test/id", mapping,
        mappingArtifactUri: "http://oswadt.test/id/semantic-artifact/11111111-1111-4111-8111-111111111111",
        idsProfileUri: "http://oswadt.test/id/semantic-artifact/22222222-2222-4222-8222-222222222222",
        idsProfileVersion: "1.1.0", runUuid: "33333333-3333-4333-8333-333333333333",
        materialisationUuid: "44444444-4444-4444-8444-444444444444",
        logicalModelUuid: "55555555-5555-4555-8555-555555555555",
        modelVersionUuid: "66666666-6666-4666-8666-666666666666", versionNumber: 1,
        filename: "model.ifc", fileSha256: "a".repeat(64), ifcSchema,
        generatedAt: "2026-08-06T12:00:00.000Z",
        spaces: [{ persistentUuid: "77777777-7777-4777-8777-777777777777", inventoryCode: "R-101",
            longName: longName ?? undefined, ifcGuid: "space-guid-v1", ifcClass: "IfcSpace", storey: "Level 1",
            persistentUri: "http://oswadt.test/id/space/77777777-7777-4777-8777-777777777777",
            manifestationUri: "http://oswadt.test/id/model-version/66666666-6666-4666-8666-666666666666/manifestation/space-guid-v1" } as any],
        assets: [] });
}

function validate(dataTurtle: string, correlationId: string) {
    return provider.validate({ dataTurtle, shapesTurtle: governedShapes, inference: "none",
        advanced: true, metaShacl: true, timeoutMs: 30_000, correlationId });
}

test("the four accepted IFC4x3 schema identifiers conform", async () => {
    for (const schema of ["IFC4X3", "IFC4X3_ADD1", "IFC4X3_ADD2", "IFC4X3_TC1"]) {
        const rdf = await modelRdf(schema);
        const report = await validate(rdf.turtle, `schema-ok-${schema}`);
        assert.equal(report.conforms, true, schema);
        assert.equal(report.resultCount, 0, schema);
    }
});

test("unsupported, pre-release and fabricated schema identifiers violate the schema constraint", async () => {
    const ifcSchemaPath = "https://deedeoliveira.github.io/GRIDD_OpenDT/ontology/model-intake-v1#ifcSchema";
    for (const schema of ["IFC4", "IFC2X3", "IFC4X3_RC1", "IFC4X3_ADD3", "IFC4X3_FAKE", "IFC4X3_ATTACK"]) {
        const rdf = await modelRdf(schema);
        const report = await validate(rdf.turtle, `schema-bad-${schema}`);
        assert.equal(report.conforms, false, schema);
        assert.ok(report.results.some((row) => row.resultPath === ifcSchemaPath),
            `${schema} must fail on the ifcSchema constraint`);
    }
});

const INVENTORY_CODE_PATH = "https://deedeoliveira.github.io/GRIDD_OpenDT/ontology/model-intake-v1#inventoryCode";

test("valid institutional inventory codes conform (datatype + pattern)", async () => {
    for (const code of ["T-101", "R-999"]) {
        const base = await modelRdf("IFC4X3_ADD2");
        const turtle = base.turtle.replace(/project:inventoryCode "R-101"/g, `project:inventoryCode "${code}"`);
        const report = await validate(turtle, `inventory-ok-${code}`);
        assert.equal(report.conforms, true, code);
        assert.equal(report.resultCount, 0, code);
    }
});

test("malformed, missing, mistyped or multiple project:inventoryCode values violate PersistentSpaceShape", async () => {
    const base = (await modelRdf("IFC4X3_ADD2")).turtle;
    const mutations: Record<string, string> = {
        missing: base.replace(/project:inventoryCode\s+"R-101"\s*;?/g, ""),
        blank: base.replace(/project:inventoryCode "R-101"/g, 'project:inventoryCode ""'),
        whitespace: base.replace(/project:inventoryCode "R-101"/g, 'project:inventoryCode "   "'),
        letters: base.replace(/project:inventoryCode "R-101"/g, 'project:inventoryCode "XYZ"'),
        lowercase: base.replace(/project:inventoryCode "R-101"/g, 'project:inventoryCode "t-101"'),
        fourDigits: base.replace(/project:inventoryCode "R-101"/g, 'project:inventoryCode "T-1010"'),
        twoDigits: base.replace(/project:inventoryCode "R-101"/g, 'project:inventoryCode "T-10"'),
        numeric: base.replace(/project:inventoryCode "R-101"/g, "project:inventoryCode 101"),
        multiple: base.replace(/project:inventoryCode "R-101"/g, 'project:inventoryCode "R-101", "R-102"'),
    };
    for (const [name, turtle] of Object.entries(mutations)) {
        const report = await validate(turtle, `inventory-bad-${name}`);
        assert.equal(report.conforms, false, `${name} must violate`);
        assert.ok(report.results.some((row) => row.resultPath === INVENTORY_CODE_PATH),
            `${name} must fail on the project:inventoryCode path`);
    }
});

test("an absent optional project:longName still conforms", async () => {
    const rdf = await modelRdf("IFC4X3_ADD2", null);
    assert.doesNotMatch(rdf.turtle, /project:longName/, "longName omitted when absent");
    const report = await validate(rdf.turtle, "longname-absent");
    assert.equal(report.conforms, true);
    assert.equal(report.resultCount, 0);
});
