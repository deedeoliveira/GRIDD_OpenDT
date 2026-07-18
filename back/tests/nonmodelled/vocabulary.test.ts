/**
 * Vocabulário operacional mínimo (Prompt 5B §19.1): termos centralizados,
 * namespace versionado, sem termos IFC, sem vocabulários externos,
 * documentado como provisório, propriedades distintas.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { operationalVocabulary, OPERATIONAL_VOCABULARY_VERSION, RDF_TYPE } = await import("../../graph/operationalVocabulary.ts");
const { stringLiteral, iri, dateTimeLiteral } = await import("../../graph/sparqlText.ts");

const BASE = "http://oswadt.local/id";
const vocab = operationalVocabulary(BASE);

test("namespace é versionado (operational-v1) e deriva da base configurada", () => {
    assert.equal(OPERATIONAL_VOCABULARY_VERSION, "operational-v1");
    assert.equal(vocab.namespace, `${BASE}/vocab/operational-v1#`);
    assert.equal(vocab.assetUuid, `${BASE}/vocab/operational-v1#assetUuid`);
});

test("todos os termos vêm do namespace do projeto — nenhum vocabulário externo além de rdf:type e XSD", () => {
    for (const [key, value] of Object.entries(vocab)) {
        if (key === "namespace") continue;
        assert.ok(String(value).startsWith(vocab.namespace), `termo '${key}' fora do namespace do projeto: ${value}`);
    }
    assert.equal(RDF_TYPE, "http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
});

test("nenhum termo IFC é usado para ativos não modelados (sem Ifc*, ObjectType, Tag, GUID, Manufacturer)", () => {
    for (const value of Object.values(vocab)) {
        assert.doesNotMatch(String(value), /Ifc|ObjectType|objectType|manufacturer|ifcGuid|EQP/i, String(value));
    }
});

test("serial, código do gestor e localização usam propriedades DISTINTAS", () => {
    const values = new Set([vocab.serialNumber, vocab.assetCode, vocab.hasLocationAssignment, vocab.assignedSpace]);
    assert.equal(values.size, 4);
});

test("vocabulário está documentado como provisório (não é a ontologia da tese nem conversão do IFC)", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "../../graph/operationalVocabulary.ts"), "utf-8");
    assert.match(source, /NÃO é a ontologia/);
    assert.match(source, /NÃO é uma conversão do IFC/);
});

test("strings RDF de termos não estão espalhadas fora de graph/ (guarda)", () => {
    const backDir = path.join(import.meta.dirname, "../..");
    const offenders: string[] = [];
    const scan = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (["node_modules", "tests", "graph", "cdn_resources", "python", "bruno_collection", "dist", ".git"].includes(entry.name)) continue;
                scan(full);
                continue;
            }
            if (!entry.name.endsWith(".ts")) continue;
            const source = fs.readFileSync(full, "utf-8");
            if (/vocab\/operational-v1#/.test(source)) offenders.push(path.relative(backDir, full));
        }
    };
    scan(backDir);
    assert.deepEqual(offenders, []);
});

test("serialização segura: literais escapados, IRIs validadas, dateTime tipado", () => {
    assert.equal(stringLiteral('a"b\nc'), '"a\\"b\\nc"');
    assert.match(dateTimeLiteral("2026-07-17T10:00:00Z"), /\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#dateTime>$/);
    assert.throws(() => iri("not a iri"), /invalid IRI|IRI must be absolute/);
    assert.throws(() => iri("http://x/`inject`"), /invalid IRI/);
});
