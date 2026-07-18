/**
 * Smoke test do grafo semântico (Prompt 5A) — diagnóstico manual/CI local.
 *
 * Executa, por esta ordem, contra os endpoints GRAPH_* configurados:
 *   1. health check (ASK {});
 *   2. PUT de um pequeno grafo EXCLUSIVAMENTE de teste
 *      ({base}/graph/test/<uuid novo>) com recursos fictícios marcados;
 *   3. SELECT dentro desse grafo;
 *   4. UPDATE (INSERT DATA) isolado no mesmo grafo;
 *   5. DELETE apenas desse grafo + confirmação de que ficou vazio.
 *
 * NUNCA escreve modelos, espaços, ativos, reservas ou resultados de política;
 * NUNCA executa CLEAR ALL / DROP ALL; apaga apenas o grafo que criou.
 *
 * Uso:
 *   npx tsx scripts/graphSmoke.ts
 * Recomendado apontar GRAPH_*_ENDPOINT ao dataset /oswadt-test (em memória);
 * correr contra /oswadt-dev também é seguro (só toca no namespace de teste).
 */
import "dotenv/config";
import { loadGraphConfig } from "../graph/graphConfig.ts";
import { getGraphClient } from "../graph/graphClientProvider.ts";
import { newTestGraphUri } from "../graph/namedGraphs.ts";

function fail(step: string, error: unknown): never {
    const message = error instanceof Error ? `${(error as any).code ?? error.name}: ${error.message}` : String(error);
    console.error(`✗ ${step} — ${message}`);
    process.exit(1);
}

async function main(): Promise<void> {
    const configResult = loadGraphConfig();
    if (!configResult.configured) {
        console.error(`✗ configuração — ${configResult.reason}`);
        console.error("  Defina GRAPH_QUERY_ENDPOINT, GRAPH_UPDATE_ENDPOINT, GRAPH_DATA_ENDPOINT e GRAPH_BASE_URI (ver .env.example).");
        process.exit(1);
    }
    const { baseUri, queryEndpoint } = configResult.config;
    console.log(`Config OK — provider=${configResult.config.provider}, query=${queryEndpoint}, base=${baseUri}`);

    const client = getGraphClient();

    const health = await client.healthCheck();
    if (!health.ok) fail("health check", new Error(`${health.errorCode}: ${health.error}`));
    console.log(`✓ health check (${health.durationMs} ms)`);

    const graphUri = newTestGraphUri(baseUri);
    console.log(`Grafo de teste desta execução: <${graphUri}>`);

    const subject = `${baseUri}/test/resource/smoke`;
    const turtle = [
        `<${subject}> <http://purl.org/dc/terms/title> "OSWADT graph smoke test resource (fictício — seguro apagar)" .`,
        `<${subject}> <http://purl.org/dc/terms/type> "test-only" .`,
    ].join("\n");

    try {
        await client.putGraph(graphUri, turtle, "text/turtle");
        console.log("✓ putGraph (2 triplos de teste)");
    } catch (error) { fail("putGraph", error); }

    try {
        const result = await client.query(
            `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`
        );
        const n = Number(result.results?.bindings?.[0]?.n?.value ?? NaN);
        if (n !== 2) throw new Error(`esperava 2 triplos, obtive ${n}`);
        console.log("✓ query (2 triplos visíveis no grafo de teste)");
    } catch (error) { fail("query", error); }

    try {
        await client.update(
            `INSERT DATA { GRAPH <${graphUri}> { <${subject}> <http://purl.org/dc/terms/description> "inserido via SPARQL update" } }`
        );
        const result = await client.query(
            `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`
        );
        const n = Number(result.results?.bindings?.[0]?.n?.value ?? NaN);
        if (n !== 3) throw new Error(`esperava 3 triplos após o update, obtive ${n}`);
        console.log("✓ update isolado no grafo de teste (3 triplos)");
    } catch (error) { fail("update", error); }

    try {
        await client.deleteGraph(graphUri);
        const ask = await client.query(`ASK { GRAPH <${graphUri}> { ?s ?p ?o } }`);
        if (ask.boolean !== false) throw new Error("o grafo de teste ainda tem triplos após o delete");
        console.log("✓ deleteGraph (apenas o grafo desta execução; agora vazio)");
    } catch (error) { fail("deleteGraph", error); }

    console.log("Smoke do grafo concluído com sucesso — nenhum dado de produção foi tocado.");
}

main().catch((error) => fail("smoke", error));
