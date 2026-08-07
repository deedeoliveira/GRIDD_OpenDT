/**
 * Architecture guards for the definitive IFC4x3 space semantics (ADR-0052). These target
 * ACTIVE source/artifact boundaries — not a blanket repository regex — and prevent
 * reintroduction of the superseded Reference / space-as-asset / assets.space_id model.
 *
 * Deliberately PERMITTED and therefore NOT scanned here: historical ADRs and audit docs,
 * migration/rollback SQL that describes the superseded schema, disposable migration
 * self-tests, tests that prove Reference is ignored / non-IFC4x3 is rejected, unrelated
 * fields such as actorReference, and the original 2026-07-17 migration that introduced
 * assets.space_id.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const back = path.resolve(process.cwd());
const repo = path.resolve(process.cwd(), "..");
const read = (rel: string) => fs.readFileSync(path.resolve(repo, rel), "utf8");
const readBack = (rel: string) => fs.readFileSync(path.resolve(back, rel), "utf8");

/* ----------------------------- RDF materialiser ----------------------------- */
test("guard: rdfMaterialiser emits project:inventoryCode/longName and never project:reference", () => {
    const src = readBack("modelIntake/rdfMaterialiser.ts");
    assert.match(src, /\$\{p\}inventoryCode/, "inventory code predicate must be emitted");
    assert.match(src, /\$\{p\}longName/, "longName predicate must be emitted");
    assert.doesNotMatch(src, /\$\{p\}reference/, "the deprecated project:reference predicate must not be emitted");
    assert.doesNotMatch(src, /space\.label/, "the ambiguous space.label alias must not be read");
    // ADR-0052 §F: the equipment→space edge is keyed on the persistent space URI, never on
    // a mutable inventory code. The old code-equality mechanism must not reappear.
    assert.doesNotMatch(src, /item\.inventoryCode\s*===\s*asset\.containingSpace/, "location must not be resolved by inventory-code equality");
    assert.match(src, /item\.persistentUri\s*===\s*asset\.containingSpacePersistentUri/, "location must be resolved by the persistent space URI");
});

/* ----------------------------- historical materialisation snapshot ----------------------------- */
test("guard: SemanticMaterialisationService sources historical space semantics from binding snapshots, not the mutable current projection", () => {
    const src = readBack("modelIntake/semanticMaterialisationService.ts");
    // The space RDF input must come from the version snapshot, never the mutable current code.
    assert.match(src, /inventoryCode: row\.inventory_code_snapshot/, "space inventoryCode must come from inventory_code_snapshot");
    assert.doesNotMatch(src, /inventoryCode: row\.inventory_code\b(?!_snapshot)/, "space inventoryCode must not use the mutable current spaces.inventory_code");
    // Equipment location is carried as an explicit persistent-space URI (from ab.space_id).
    assert.match(src, /containingSpacePersistentUri:/, "equipment location must be an explicit persistent-space URI");
    assert.doesNotMatch(src, /row\.space_inventory_code\b(?!_snapshot)/, "the mutable current space code must not be read as the location key");
    // The version-snapshot query must not expose the mutable current containing-space code.
    const db = readBack("utils/modelIntakeDatabase.ts");
    assert.doesNotMatch(db, /s\.inventory_code AS space_inventory_code\b/, "getVersionSnapshot must not select the mutable current containing-space code");
    assert.match(db, /sbs\.inventory_code_snapshot AS space_inventory_code_snapshot/, "getVersionSnapshot must expose the version-accurate containing-space snapshot");
});

/* ----------------------------- governed RDF mapping ----------------------------- */
test("guard: governed RDF mapping uses inventoryCode/longName predicates, not project:reference or Pset_SpaceCommon.Reference", () => {
    const mapping = read("semantic/artifacts/runtime/oswadt-ifc4-minimal-rdf-mapping/1.1.0/oswadt-ifc4-minimal-rdf-mapping-v1.1.json");
    const json = JSON.parse(mapping);
    assert.ok(json.predicates.includes("project:inventoryCode"), "inventoryCode predicate required");
    assert.ok(json.predicates.includes("project:longName"), "longName predicate required");
    assert.ok(!json.predicates.includes("project:reference"), "project:reference predicate must be gone");
    assert.ok(!json.includedProperties.includes("Pset_SpaceCommon.Reference"), "Reference property must not be mapped");
    assert.match(String(json.identityRules.space), /GlobalId/, "space identity is GlobalId, never Reference");
    assert.doesNotMatch(String(json.identityRules.space), /Pset_SpaceCommon\.Reference/);
});

/* ----------------------------- governed SHACL ----------------------------- */
test("guard: governed SHACL requires project:inventoryCode, an IFC4X3 schema, and never a space Reference or space-as-asset", () => {
    const shapes = read("semantic/artifacts/runtime/oswadt-model-rdf-structural-shapes/1.1.0/oswadt-model-rdf-structural-shapes-v1.1.ttl");
    assert.match(shapes, /project:inventoryCode/, "inventoryCode constraint required");
    // The schema constraint must be the fully-anchored four-identifier alternation, not the
    // loose prefix; ^IFC4X3 alone would conform invented IFC4X3_* variants.
    assert.match(shapes, /sh:pattern "\^\(IFC4X3\|IFC4X3_ADD1\|IFC4X3_ADD2\|IFC4X3_TC1\)\$"/, "schema constraint must be the exact four-schema alternation");
    assert.doesNotMatch(shapes, /sh:pattern "\^IFC4X3"/, "the loose ^IFC4X3 prefix pattern must be gone");
    assert.doesNotMatch(shapes, /project:reference/, "no space Reference constraint");
    assert.doesNotMatch(shapes, /sh:pattern "\^IFC4"[^X]/, "the loose ^IFC4 pattern must be gone");
    // PersistentSpaceShape must validate the inventory-code datatype AND the institutional
    // pattern governed by the IDS — not merely minLength.
    const spaceShape = shapes.slice(shapes.indexOf("PersistentSpaceShape"));
    assert.match(spaceShape, /project:inventoryCode[^\]]*sh:datatype xsd:string/, "inventoryCode must require xsd:string");
    assert.match(spaceShape, /project:inventoryCode[^\]]*sh:pattern "\^\[A-Z\]-\[0-9\]\{3\}\$"/, "inventoryCode must enforce the institutional pattern");
});

/* ----------------------------- governed IDS ----------------------------- */
test("guard: governed IDS requires IfcSpace.Name (IFC4X3_ADD2) and does not require Pset_SpaceCommon.Reference", () => {
    const ids = read("semantic/artifacts/runtime/oswadt-ifc4-model-requirements/1.1.0/oswadt-ifc4-model-requirements-v1.1.ids");
    assert.match(ids, /identifier="IDS-SPACE-NAME"/, "the space rule targets Name");
    assert.match(ids, /ifcVersion="IFC4X3_ADD2"/, "IFC4x3 applicability");
    assert.doesNotMatch(ids, /IDS-SPACE-REFERENCE/, "the old Reference rule id must be gone");
    assert.doesNotMatch(ids, /<simpleValue>Reference<\/simpleValue>/, "no Reference requirement");
    assert.doesNotMatch(ids, /ifcVersion="IFC4"/, "no IFC4 applicability");
});

/* ----------------------------- space-as-asset removal ----------------------------- */
test("guard: assetInventoryService never creates a space asset nor writes assets.space_id", () => {
    const src = readBack("services/assetInventoryService.ts");
    assert.doesNotMatch(src, /assetType:\s*"space"/, "no space asset creation");
    // Equipment createAsset must not pass a spaceId (persistent row holds no location).
    assert.doesNotMatch(src, /createAsset\([^)]*spaceId/s, "createAsset must not receive a spaceId");
});

test("guard: reservation resolution and discovery restrict resources to equipment/tool", () => {
    const persistent = readBack("utils/persistentAssetDatabase.ts");
    const nonModelled = readBack("utils/nonModelledAssetDatabase.ts");
    const reservation = readBack("utils/reservationDatabase.ts");
    assert.match(persistent, /asset_type IN \('equipment', 'tool'\)/, "reservable resolver excludes spaces");
    assert.match(nonModelled, /asset_type IN \('equipment', 'tool'\)/, "discovery excludes spaces");
    assert.match(reservation, /not a reservable resource/, "creation rejects a space resource");
    assert.doesNotMatch(persistent, /createAsset[\s\S]{0,200}assetType:\s*"space"/);
});

/* ----------------------------- demo project rule ----------------------------- */
test("guard: demo project rule reads IfcSpace.Name, never Pset_SpaceCommon.Reference", () => {
    const src = readBack("requirements/demoProjectRules.ts");
    assert.match(src, /spaceName/, "rule keys on Name");
    assert.doesNotMatch(src, /psets\?\.\s*Pset_SpaceCommon\?\.\s*Reference/, "must not read Reference");
});

/* ----------------------------- API / version-resources ----------------------------- */
test("guard: version-resources and preview expose inventoryCode/longName, no active reference alias or name_snapshot", () => {
    const service = readBack("modelIntake/modelIntakeService.ts");
    assert.doesNotMatch(service, /reference:\s*space\.inventory_code/, "no reference alias for IfcSpace.Name");
    assert.doesNotMatch(service, /\?\?\s*space\.name_snapshot/, "no dropped name_snapshot fallback in code");
    assert.match(service, /inventoryCode: space\.inventory_code_snapshot/, "explicit inventoryCode");
    assert.match(service, /longName: space\.long_name_snapshot/, "explicit longName");
    const types = readBack("modelIntake/modelIntakeTypes.ts");
    assert.doesNotMatch(types, /\n\s*label:\s*string/, "PreviewSpace must not carry an ambiguous label field");
});

/* ----------------------------- IFC4x3 schema gate ----------------------------- */
test("guard: startsWith(\"IFC4\") lives only in the central rejection classifier", () => {
    const support = readBack("utils/ifcSchemaSupport.ts");
    // Exactly one occurrence, and it is the rejection branch mapping to unsupported_ifc4.
    const occurrences = (support.match(/startsWith\("IFC4"\)/g) ?? []).length;
    assert.equal(occurrences, 1, "single startsWith(\"IFC4\") — the rejection branch only");
    assert.match(support, /startsWith\("IFC4"\)[\s\S]{0,60}unsupported_ifc4/, "it must classify as a rejection");
    // No production entry point re-accepts IFC4 via a bare prefix.
    for (const rel of ["modelIntake/modelIntakeService.ts", "services/modelUploadService.ts"]) {
        assert.doesNotMatch(readBack(rel), /startsWith\("IFC4"\)/, `${rel} must delegate to the central gate`);
    }
});

/* ----------------------------- no zones / no space_id equipment-location ----------------------------- */
test("guard: no IfcSpatialZone / reservation_zone, and no active assets.space_id read", () => {
    for (const rel of ["services/assetInventoryService.ts", "utils/persistentAssetDatabase.ts",
        "utils/nonModelledAssetDatabase.ts", "utils/reservationDatabase.ts", "modelIntake/modelIntakeService.ts"]) {
        const src = readBack(rel);
        assert.doesNotMatch(src, /IfcSpatialZone|reservation_zone/i, `${rel} must not implement zones`);
        // Active SELECT/INSERT/UPDATE of assets.space_id (a.space_id) is prohibited; the column is dropped.
        assert.doesNotMatch(src, /\ba\.space_id\b/, `${rel} must not read assets.space_id`);
    }
});
