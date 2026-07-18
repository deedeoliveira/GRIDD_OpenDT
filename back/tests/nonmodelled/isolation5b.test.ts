/**
 * Isolamento de falhas do Prompt 5B (§18/§19.11): o grafo só é alcançável a
 * partir dos serviços EXPLÍCITOS de ativos não modelados; upload, preflight,
 * reservas, viewer, sensores e políticas continuam sem qualquer dependência.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const backDir = path.join(import.meta.dirname, "../..");

/** Módulos 5B autorizados a conhecer o grafo (além de graph/, scripts/, tests/). */
export const GRAPH_AWARE_5B = [
    "services/nonModelledAssetRegistrationService.ts",
    "services/nonModelledAssetLocationService.ts",
    "services/nonModelledSyncSupport.ts",
    "services/graphSqlReconciliationService.ts",
];

function read(relative: string): string {
    return fs.readFileSync(path.join(backDir, relative), "utf-8");
}

test("upload IFC e preflight não importam grafo nem serviços de ativos não modelados", () => {
    for (const file of ["services/modelUploadService.ts", "services/assetInventoryService.ts", "services/spaceIdentityService.ts", "services/preprocessService.ts"]) {
        const source = read(file);
        assert.doesNotMatch(source, /nonModelled/i, file);
        assert.doesNotMatch(source, /from\s+["'][^"']*graph\//, file);
    }
});

test("reservas, sensores e viewer (rotas) não importam o módulo do grafo", () => {
    for (const file of ["utils/reservationDatabase.ts", "utils/assetDatabase.ts", "routes/reservation.ts", "routes/sensor.ts", "routes/model.ts", "routes/space.ts"]) {
        const source = read(file);
        assert.doesNotMatch(source, /from\s+["'][^"']*graph\//, file);
    }
});

test("apenas os serviços explícitos 5B importam o grafo (lista fechada e documentada)", () => {
    const servicesDir = path.join(backDir, "services");
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(servicesDir)) {
        if (!entry.endsWith(".ts")) continue;
        const source = fs.readFileSync(path.join(servicesDir, entry), "utf-8");
        if (/from\s+["'][^"']*graph\//.test(source) && !GRAPH_AWARE_5B.includes(`services/${entry}`)) {
            offenders.push(entry);
        }
    }
    assert.deepEqual(offenders, []);
});

test("o gating de reservas 5B é SQL puro: reservationDatabase não fala SPARQL nem usa GraphClient", () => {
    const source = read("utils/reservationDatabase.ts");
    assert.doesNotMatch(source, /sparql|GraphClient|getGraphClient/i);
    assert.match(source, /semantic_sync_operations/, "consulta o ESTADO projetado da sincronização (tabela SQL)");
});

test("sem grafo configurado, o registo falha com graph_not_configured — e NADA mais falha", async () => {
    const saved: Record<string, string | undefined> = {};
    for (const name of Object.keys(process.env)) {
        if (name.startsWith("GRAPH_")) { saved[name] = process.env[name]; delete process.env[name]; }
    }
    try {
        const { getOperationalGraphContext } = await import("../../services/nonModelledSyncSupport.ts");
        const graphProvider = await import("../../graph/graphClientProvider.ts");
        graphProvider.resetGraphClient();

        assert.throws(
            () => getOperationalGraphContext(),
            (error: any) => error.code === "graph_not_configured" && error.statusCode === 503
                && /rest of the application is unaffected/.test(error.message)
        );
    } finally {
        for (const [name, value] of Object.entries(saved)) {
            if (value !== undefined) process.env[name] = value;
        }
    }
});

test("frontend nunca escreve diretamente no grafo nem no SQL de projeção (toda a alteração passa pelos serviços)", () => {
    const frontDir = path.join(backDir, "../front");
    const offenders: string[] = [];
    const scan = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (["node_modules", ".next", "out", "build"].includes(entry.name)) continue;
                scan(full);
                continue;
            }
            if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
            const source = fs.readFileSync(full, "utf-8");
            if (/3030|sparql|INSERT DATA|semantic_sync_operations/i.test(source)) offenders.push(full);
        }
    };
    scan(frontDir);
    assert.deepEqual(offenders, []);
});
