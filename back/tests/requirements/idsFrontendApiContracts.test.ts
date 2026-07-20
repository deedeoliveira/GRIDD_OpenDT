import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("demo route is POST-only, allowlisted, feature-gated, and does not expose arbitrary paths", () => {
    const route = fs.readFileSync(path.resolve(process.cwd(), "routes/modelRequirements.ts"), "utf8");
    assert.match(route, /router\.post\("\/demo\/:scenario"/);
    assert.match(route, /config\.demoMode/);
    assert.match(route, /isIdsDemoScenario/);
    assert.doesNotMatch(route, /req\.(body|query).*path/);
});

test("frontend separates IDS and project layers and keeps the non-decision warning visible", () => {
    const page = fs.readFileSync(path.resolve(process.cwd(), "../front/app/ids-demo/page.tsx"), "utf8");
    assert.match(page, /IDS requirements/);
    assert.match(page, /Project-specific rules/);
    assert.match(page, /does not determine reservability, eligibility, authorization or approval/);
    assert.doesNotMatch(page, /SPARQL|Fuseki|api\/reservation|source_model\.ifc|<ids/);
});
