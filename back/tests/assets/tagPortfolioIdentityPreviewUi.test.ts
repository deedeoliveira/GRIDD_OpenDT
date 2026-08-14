/**
 * TAG-1 V3 — o ECRÃ do gestor BIM distingue os três estados de identidade persistente.
 *
 * O defeito corrigido: `new` e `ambiguous` serializavam ambos `persistentUuid: "candidate"`
 * e o frontend ignorava por completo os campos de estado — declarava um tipo `Asset` local
 * sem `persistentAssetStatus`/`ambiguousAssetUuids` e imprimia `r.persistentUuid` em bruto
 * na coluna do UUID. Resultado: "novo" e "ambíguo" apareciam como o MESMO texto literal
 * "candidate", indistinguíveis para o utilizador.
 *
 * ESTILO: caracterização por inspeção da fonte. O `front/` deste repositório não tem
 * qualquer infraestrutura de testes de componente (o `front/package.json` só define
 * dev/build/start; não há jest, vitest nem testing-library instalados), e o enunciado
 * proíbe introduzir um novo framework de browser só para isto. É exatamente o mesmo
 * padrão já usado por back/tests/semantic/modelIntakeContextCoverage.test.ts,
 * shaclGovernance.test.ts e reservationManagerQueue.test.ts para caracterizar esta
 * mesma página. Limitação assumida e declarada: prova o CONTRATO da fonte, não um
 * render em DOM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const dashboard = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../../front/app/(admin)/dashboard/page.tsx"), "utf8");

/** A célula de identidade do ativo e o tipo local que a alimenta. */
const assetType = dashboard.slice(dashboard.indexOf("type Asset = {"), dashboard.indexOf("type Run = {"));
const cell = dashboard.slice(dashboard.indexOf("function assetIdentityCell"), dashboard.indexOf("function Table("));

test("UI: o tipo local Asset já conhece o estado de identidade e o UUID anulável", () => {
    assert.match(assetType, /persistentAssetStatus: AssetStatus/);
    assert.match(assetType, /ambiguousAssetUuids: string\[\] \| null/);
    assert.match(assetType, /persistentUuid: string \| null/,
        "o JSON pode trazer null (ambíguo): o tipo do frontend tem de o admitir");
    assert.match(dashboard, /type AssetStatus = "existing" \| "new" \| "ambiguous"/);
});

test("UI existing: o UUID persistente real continua a ser mostrado", () => {
    assert.match(cell, /return r\.persistentUuid \?\? "—"/,
        "o caso existing mostra o UUID real, como antes");
});

test("UI new: mostra um rótulo explícito de novo candidato, não o literal em bruto", () => {
    assert.match(cell, /r\.persistentAssetStatus === "new"/);
    assert.match(cell, /New candidate/i);
});

test("UI ambiguous: mostra revisão obrigatória e NÃO descarta os UUID em conflito", () => {
    assert.match(cell, /r\.persistentAssetStatus === "ambiguous"/);
    assert.match(cell, /Ambiguous[\s\S]*?review required/i,
        "a ambiguidade é apresentada como estado de pré-voo que exige revisão");
    assert.match(cell, /r\.ambiguousAssetUuids/);
    assert.match(cell, /conflicting[\s\S]*?join\(/i,
        "a evidência dos UUID em conflito é exibida, não silenciosamente deitada fora");
});

test("UI: o literal 'candidate' NUNCA é impresso como se fosse um UUID persistente", () => {
    // A célula decide SEMPRE pelo estado; não há qualquer literal "candidate" no ecrã,
    // nem qualquer comparação com esse sentinela (o sentinela é do backend, não da UI).
    assert.ok(!/"candidate"/.test(cell), "a UI não conhece nem imprime o sentinela 'candidate'");
    assert.ok(!/persistentUuid === "candidate"/.test(dashboard));
    // Nem o `null` em bruto escapa para o ecrã: o ramo que devolve persistentUuid é o
    // último, alcançável só em `existing`, e ainda assim tem fallback.
    assert.match(cell, /\?\? "—"/);
});

test("UI: a tabela de ativos passa pela célula de estado, não por r.persistentUuid em bruto", () => {
    const table = dashboard.slice(dashboard.indexOf("function AssetTable"), dashboard.indexOf("function Table("));
    assert.match(table, /assetIdentityCell\(r\)/);
    assert.ok(!/\[r\.persistentUuid,/.test(table),
        "a coluna já não imprime o valor bruto do UUID como primeira célula");
});

test("UI: a tabela de ESPAÇOS fica intocada — contrato binário 'candidate' diferente", () => {
    const spaceTable = dashboard.slice(dashboard.indexOf("function SpaceTable"), dashboard.indexOf("function AssetTable"));
    assert.match(spaceTable, /\[r\.persistentUuid, r\.inventoryCode/);
    assert.match(dashboard, /type Space = \{ persistentUuid: string;/,
        "PreviewSpace continua binário: o seu persistentUuid nunca é null");
});

test("UI: a pré-visão ambígua não muta nada nem cria reconciliação a partir do frontend", () => {
    // A célula é uma função pura de apresentação: sem fetch, sem POST, sem setState.
    assert.ok(!/fetch\(|method:\s*"POST"|setRun\(|useState/.test(cell),
        "a reconciliação é exclusiva do caminho autoritativo de ingestão, nunca do ecrã");
    assert.match(cell, /^function assetIdentityCell\(r: Asset\) \{/m);
});
