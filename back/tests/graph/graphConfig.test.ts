/**
 * Configuração do grafo (Prompt 5A): opcionalidade, validação explícita,
 * guardas de ambiente de teste e ausência de credenciais em mensagens.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { loadGraphConfig, validateBaseUri, DEFAULT_GRAPH_REQUEST_TIMEOUT_MS } = await import("../../graph/graphConfig.ts");
const { GraphError } = await import("../../graph/graphTypes.ts");
const provider = await import("../../graph/graphClientProvider.ts");

const GRAPH_VARS = [
    "GRAPH_PROVIDER", "GRAPH_QUERY_ENDPOINT", "GRAPH_UPDATE_ENDPOINT", "GRAPH_DATA_ENDPOINT",
    "GRAPH_USERNAME", "GRAPH_PASSWORD", "GRAPH_REQUEST_TIMEOUT_MS", "GRAPH_BASE_URI",
];

function cleanEnv(): void {
    for (const name of GRAPH_VARS) delete process.env[name];
}

function validEnv(): NodeJS.ProcessEnv {
    return {
        GRAPH_QUERY_ENDPOINT: "http://localhost:3030/oswadt-test/query",
        GRAPH_UPDATE_ENDPOINT: "http://localhost:3030/oswadt-test/update",
        GRAPH_DATA_ENDPOINT: "http://localhost:3030/oswadt-test/data",
        GRAPH_BASE_URI: "http://oswadt.local/id",
    };
}

beforeEach(() => {
    cleanEnv();
    provider.resetGraphClient();
});

test("sem variáveis GRAPH_*: configured=false — o grafo é opcional e o arranque não é bloqueado", () => {
    const result = loadGraphConfig({});
    assert.equal(result.configured, false);
    if (!result.configured) assert.match(result.reason, /not configured/);
});

test("configuração completa é validada e aplicam-se os defaults (provider fuseki, timeout 10000)", () => {
    const result = loadGraphConfig(validEnv());
    assert.equal(result.configured, true);
    if (result.configured) {
        assert.equal(result.config.provider, "fuseki");
        assert.equal(result.config.requestTimeoutMs, DEFAULT_GRAPH_REQUEST_TIMEOUT_MS);
        assert.equal(result.config.baseUri, "http://oswadt.local/id");
        assert.equal(result.config.username, null);
        assert.equal(result.config.password, null);
    }
});

test("configuração PARCIAL falha de forma controlada com as variáveis em falta na mensagem", () => {
    assert.throws(
        () => loadGraphConfig({ GRAPH_QUERY_ENDPOINT: "http://localhost:3030/ds/query" }),
        (error: any) => error instanceof GraphError
            && error.code === "graph_configuration_error"
            && /GRAPH_UPDATE_ENDPOINT/.test(error.message)
            && /GRAPH_BASE_URI/.test(error.message)
    );
});

test("base URI inválida é rejeitada (sem esquema, com espaços, com query/fragmento)", () => {
    for (const bad of ["oswadt/id", "http://oswadt.local/id espaço", "http://oswadt.local/id?x=1", "http://oswadt.local/id#frag", ""]) {
        assert.throws(
            () => loadGraphConfig({ ...validEnv(), GRAPH_BASE_URI: bad }),
            (error: any) => error instanceof GraphError && error.code === "graph_configuration_error",
            `base URI aceite indevidamente: '${bad}'`
        );
    }
    assert.equal(validateBaseUri("http://oswadt.local/id/"), "http://oswadt.local/id", "barra final é normalizada");
});

test("timeout inválido é rejeitado com mensagem clara", () => {
    for (const bad of ["abc", "-5", "0", "1.5", "999999999"]) {
        assert.throws(
            () => loadGraphConfig({ ...validEnv(), GRAPH_REQUEST_TIMEOUT_MS: bad }),
            (error: any) => error instanceof GraphError
                && error.code === "graph_configuration_error"
                && /GRAPH_REQUEST_TIMEOUT_MS/.test(error.message),
            `timeout aceite indevidamente: '${bad}'`
        );
    }
});

test("username sem password (e vice-versa) é configuração inválida", () => {
    assert.throws(
        () => loadGraphConfig({ ...validEnv(), GRAPH_USERNAME: "admin" }),
        /GRAPH_USERNAME and GRAPH_PASSWORD/
    );
    assert.throws(
        () => loadGraphConfig({ ...validEnv(), GRAPH_PASSWORD: "x" }),
        /GRAPH_USERNAME and GRAPH_PASSWORD/
    );
});

test("mensagens de erro de configuração nunca contêm a password", () => {
    const password = "super-secreta-nao-pode-aparecer";
    try {
        loadGraphConfig({
            ...validEnv(),
            GRAPH_USERNAME: "admin",
            GRAPH_PASSWORD: password,
            GRAPH_REQUEST_TIMEOUT_MS: "abc",
        });
        assert.fail("devia ter lançado");
    } catch (error: any) {
        assert.ok(!String(error.message).includes(password));
        assert.ok(!String(error.stack ?? "").includes(password));
    }
});

test("NODE_ENV=test recusa endpoints de grafo não-locais (nunca apontar testes a produção)", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
        assert.throws(
            () => loadGraphConfig({
                ...validEnv(),
                NODE_ENV: "test",
                GRAPH_QUERY_ENDPOINT: "https://graph.example.org/prod/query",
            }),
            (error: any) => error instanceof GraphError
                && error.code === "graph_configuration_error"
                && /localhost/.test(error.message)
        );
        const local = loadGraphConfig({ ...validEnv(), NODE_ENV: "test" });
        assert.equal(local.configured, true, "endpoints localhost continuam válidos em teste");
    } finally {
        if (previous === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previous;
    }
});

test("provider desconhecido falha de forma controlada (GRAPH_PROVIDER=nao-existe)", () => {
    Object.assign(process.env, validEnv(), { GRAPH_PROVIDER: "nao-existe" });
    assert.throws(
        () => provider.getGraphClient(),
        (error: any) => error instanceof GraphError
            && error.code === "graph_configuration_error"
            && /Unknown graph provider/.test(error.message)
    );
});

test("sem configuração, getGraphClient lança graph_not_configured (só quando é explicitamente chamado)", () => {
    assert.throws(
        () => provider.getGraphClient(),
        (error: any) => error instanceof GraphError && error.code === "graph_not_configured"
    );
    assert.equal(provider.isGraphConfigured(), false);
});
