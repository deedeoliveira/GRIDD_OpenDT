import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const page = fs.readFileSync(path.resolve(import.meta.dirname, "../../../front/app/semantic-demo/page.tsx"), "utf8");
const proxies = [
    path.resolve(import.meta.dirname, "../../../front/app/api/institutional/demo/actors/route.ts"),
    path.resolve(import.meta.dirname, "../../../front/app/api/institutional/actors/[actorKey]/context/route.ts"),
].map((file) => fs.readFileSync(file, "utf8")).join("\n");

test("semantic demo contains loading, success, no-supervisor, revoked and feature-disabled states", () => {
    for (const text of [
        "Loading governed institutional evidence", "Verified institutional person",
        "No supervisor assertion is present in the active synthetic graph",
        "Link found · evidence not used", "demonstrator is disabled",
    ]) assert.match(page, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("semantic demo permanently displays scientific caveats", () => {
    assert.match(page, /Synthetic research demonstrator/);
    assert.match(page, /actor key is not authenticated/i);
    assert.match(page, /does not authorize or approve a reservation/i);
});

test("frontend is read-only and never accesses Fuseki or SPARQL directly", () => {
    const all = `${page}\n${proxies}`;
    assert.doesNotMatch(all, /3030|SPARQL|SELECT\s+[?(]|INSERT\s+(DATA|DELETE)|DELETE\s+(DATA|WHERE)|GRAPH\s+</i);
    assert.doesNotMatch(proxies, /export async function (POST|PUT|PATCH|DELETE)/);
    assert.match(proxies, /BASE_API_URL/);
});
