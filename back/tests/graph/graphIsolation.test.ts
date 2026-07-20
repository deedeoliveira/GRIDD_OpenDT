/**
 * Isolamento de falhas (Prompt 5A): a fundação do grafo NÃO pode tocar no
 * fluxo operacional. A prova é dupla:
 *  1. varrimento do código — NENHUM módulo operacional (serviços, rotas,
 *     políticas, identidade, classificação, requisitos, utils, index)
 *     importa back/graph/ nem fala SPARQL diretamente → indisponibilidade do
 *     grafo não pode quebrar upload, preflight, reservas, viewer, sensores
 *     nem políticas, não altera current_version_id/bindings e não há
 *     dual-write nem retry implícito;
 *  2. runtime — sem NENHUMA variável GRAPH_*, o carregamento é inofensivo e
 *     só uma chamada explícita a getGraphClient() falha (graph_not_configured).
 *     (Os restantes 253+ testes da suíte correm todos sem grafo configurado —
 *     essa é a prova de regressão em execução.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { loadGraphConfig } = await import("../../graph/graphConfig.ts");
const provider = await import("../../graph/graphClientProvider.ts");
const { GraphError } = await import("../../graph/graphTypes.ts");

const backDir = path.join(import.meta.dirname, "../..");

/**
 * (Prompt 5B) Exceção EXPLÍCITA e fechada: os serviços de ativos NÃO
 * modelados são os únicos módulos operacionais autorizados a usar o grafo —
 * é essa a sua função (grafo = autoridade desses ativos). Upload, preflight,
 * reservas, viewer, sensores e políticas continuam proibidos (testes abaixo
 * e tests/nonmodelled/isolation5b.test.ts).
 */
const GRAPH_AWARE_5B_FILES = new Set([
    "services/nonModelledAssetRegistrationService.ts",
    "services/nonModelledAssetLocationService.ts",
    "services/nonModelledSyncSupport.ts",
    "services/graphSqlReconciliationService.ts",
    "routes/semantic.ts",
    "routes/asset.ts", // importa os serviços 5B (não o grafo diretamente)
    "utils/nonModelledAssetDatabase.ts", // projeção SQL 5B (conserva semantic_uri/asset_uuid)
    // Prompt 7B1: persistência dedicada do registry, usada apenas pela CLI
    // semântica opt-in; não participa em upload/reservas/startup.
    "utils/semanticArtifactDatabase.ts",
]);

/** Diretórios que PODEM conhecer o grafo: módulo, CLI/testes e camada semântica isolada. */
const ALLOWED_DIRS = new Set(["graph", "scripts", "tests", "semantic"]);
const SKIPPED_DIRS = new Set(["node_modules", "cdn_resources", "python", "bruno_collection", "dist", ".git", ...ALLOWED_DIRS]);

function operationalSources(): { file: string; source: string }[] {
    const results: { file: string; source: string }[] = [];
    const scan = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (dir === backDir && SKIPPED_DIRS.has(entry.name)) continue;
                if (SKIPPED_DIRS.has(entry.name)) continue;
                scan(full);
                continue;
            }
            if (!entry.name.endsWith(".ts")) continue;
            const relative = path.relative(backDir, full).replace(/\\/g, "/");
            if (GRAPH_AWARE_5B_FILES.has(relative)) continue;
            results.push({ file: relative, source: fs.readFileSync(full, "utf-8") });
        }
    };
    scan(backDir);
    return results;
}

test("nenhum módulo operacional importa back/graph/ (sem dual-write; falha do grafo não alcança o fluxo atual)", () => {
    const offenders = operationalSources()
        .filter(({ source }) => /from\s+["'][^"']*graph\//.test(source) || /import\(["'][^"']*graph\//.test(source))
        .map(({ file }) => file);
    assert.deepEqual(offenders, []);
});

test("nenhum módulo operacional fala SPARQL nem lê variáveis GRAPH_* diretamente", () => {
    const offenders = operationalSources()
        .filter(({ source }) => /GRAPH_(QUERY|UPDATE|DATA)_ENDPOINT|GRAPH_BASE_URI|sparql/i.test(source))
        .map(({ file }) => file);
    assert.deepEqual(offenders, []);
});

test("semantic_uri: só a projeção 5B (source='graph') a escreve — ativos MODELADOS nunca (sem backfill)", () => {
    const offenders: string[] = [];
    for (const { file, source } of operationalSources()) {
        if (/semantic_uri/i.test(source)) offenders.push(file);
    }
    // scripts/ pode LER (relatório legado read-only), mas nunca escrever
    for (const entry of fs.readdirSync(path.join(backDir, "scripts"))) {
        if (!entry.endsWith(".ts")) continue;
        const source = fs.readFileSync(path.join(backDir, "scripts", entry), "utf-8");
        if (/(INSERT|UPDATE)[\s\S]{0,400}semantic_uri/i.test(source)) offenders.push(`scripts/${entry}`);
    }
    assert.deepEqual(offenders, []);

    // e o caminho dos ativos modelados continua sem escrever URI alguma
    const modelledSource = fs.readFileSync(path.join(backDir, "utils/persistentAssetDatabase.ts"), "utf-8");
    assert.doesNotMatch(modelledSource, /semantic_uri\s*[,=)]/i);
});

test("a camada de políticas não conhece o cliente de grafo (o GraphClient NÃO é provider de política)", () => {
    const policiesDir = path.join(backDir, "policies");
    for (const entry of fs.readdirSync(policiesDir)) {
        if (!entry.endsWith(".ts")) continue;
        const source = fs.readFileSync(path.join(policiesDir, entry), "utf-8");
        assert.doesNotMatch(source, /graph|Sparql|GraphClient/i, `policies/${entry}`);
    }
});

test("sem variáveis GRAPH_*: config inofensiva no arranque; só a chamada explícita falha", () => {
    const saved: Record<string, string | undefined> = {};
    for (const name of Object.keys(process.env)) {
        if (name.startsWith("GRAPH_")) { saved[name] = process.env[name]; delete process.env[name]; }
    }
    provider.resetGraphClient();
    try {
        const result = loadGraphConfig();
        assert.equal(result.configured, false, "carregar a configuração ausente não lança");
        assert.equal(provider.isGraphConfigured(), false);
        assert.throws(
            () => provider.getGraphClient(),
            (error: any) => error instanceof GraphError && error.code === "graph_not_configured"
        );
    } finally {
        for (const [name, value] of Object.entries(saved)) {
            if (value !== undefined) process.env[name] = value;
        }
        provider.resetGraphClient();
    }
});

test("cliente substituível nos testes via provider central (setGraphClient/resetGraphClient)", async () => {
    const fake = {
        providerId: "fake",
        healthCheck: async () => ({ ok: true, provider: "fake", queryEndpoint: "fake", durationMs: 0, errorCode: null, error: null }),
        putGraph: async () => {},
        query: async () => ({ head: {}, boolean: true }),
        update: async () => {},
        deleteGraph: async () => {},
    };
    provider.setGraphClient(fake as any);
    assert.equal((await provider.getGraphClient().healthCheck()).provider, "fake");
    provider.resetGraphClient();
});
