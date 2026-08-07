/**
 * REAL controlled-intake boundary test (ADR-0052 §A): drives the actual
 * ModelIntakeService.preflight with REAL IfcOpenShell extraction on geometry-free
 * fixtures, and proves the IFC4x3-only schema gate:
 *   - IFC4X3_ADD2 → accepted by the gate (execution proceeds PAST it into IDS);
 *   - IFC4       → 422 unsupported_ifc_schema, thrown BEFORE any IDS/RDF/DB work;
 *   - IFC2X3     → 422 unsupported_ifc_schema, BEFORE any IDS/RDF/DB work.
 *
 * Post-gate dependencies (IDS provider / profile resolver / RDF mapping) are throwing
 * proxies that record a "reached" marker, so a rejected schema NEVER reaches them and an
 * accepted schema demonstrably DOES — the gate's ordering is verified, not assumed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installFakeMySQL } from "../helpers/fakeDb.ts";

// Stub mysql2 before importing the service graph (module-scope DB singletons connect on
// import). The gate under test never reaches the database on a rejected schema anyway.
installFakeMySQL();
const { ModelIntakeService } = await import("../../modelIntake/modelIntakeService.ts");

const FIX = path.resolve(import.meta.dirname, "../fixtures");
process.env.MODEL_INTAKE_WORKSPACE_ENABLED = "true";

function service() {
    // Only getModelContext is legitimately needed before the gate; any OTHER database call
    // means the gate failed to run first.
    const db: any = {
        getModelContext: async () => ({ id: 1, linked_model_id: 1, model_uuid: "m-1" }),
    };
    const dbProxy: any = new Proxy(db, {
        get(target, prop: string) {
            if (prop in target) return (target as any)[prop];
            return () => { throw new Error(`unexpected DB call after gate: ${prop}`); };
        },
    });
    const reached = (name: string) => () => { const e: any = new Error(`reached ${name} after gate`); e.reachedStage = name; throw e; };
    const idsProvider: any = new Proxy({}, { get: (_t, p: string) => reached(`ids:${p}`) });
    const profiles: any = new Proxy({}, { get: (_t, p: string) => reached(`ids_profile:${p}`) });
    const mappings: any = new Proxy({}, { get: (_t, p: string) => reached(`rdf_mapping:${p}`) });
    return new ModelIntakeService(dbProxy, idsProvider, profiles, mappings);
}

function ifcFile(name: string) {
    const p = path.join(FIX, name);
    return { path: p, originalname: name, size: fs.statSync(p).size };
}

async function run(name: string): Promise<any> {
    return service().preflight({ ifcFile: ifcFile(name), idsMode: "active", modelId: 1 }, false)
        .then(() => null, (e: any) => e);
}

test("controlled preflight: IFC4 → 422 unsupported_ifc_schema before any IDS/RDF/DB work", async () => {
    const e = await run("ifc4-single-space-unsupported.ifc");
    assert.ok(e, "must reject");
    assert.equal(e.code, "unsupported_ifc_schema");
    assert.equal(e.statusCode, 422);
    assert.match(e.message, /IFC4x3/);
    assert.equal(e.reachedStage, undefined, "IDS/profile/RDF was never reached");
});

test("controlled preflight: IFC2X3 → 422 unsupported_ifc_schema before any IDS/RDF/DB work", async () => {
    const e = await run("ifc2x3-single-space-unsupported.ifc");
    assert.ok(e, "must reject");
    assert.equal(e.code, "unsupported_ifc_schema");
    assert.equal(e.statusCode, 422);
    assert.equal(e.reachedStage, undefined, "IDS/profile/RDF was never reached");
});

test("controlled preflight: IFC4X3_ADD2 → gate ACCEPTS; execution proceeds past it into IDS", async () => {
    const e = await run("ifc4x3-three-space-baseline.ifc");
    assert.ok(e, "the throwing IDS/profile stub fires after the gate accepts");
    assert.notEqual(e.code, "unsupported_ifc_schema", "IFC4x3 is NOT rejected by the gate");
    assert.match(String(e.reachedStage ?? e.message), /ids|profile|rdf|reached/i,
        "a post-gate stage was reached, proving IFC4x3 passed the schema gate");
});
