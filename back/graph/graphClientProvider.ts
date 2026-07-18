/**
 * Ponto ÚNICO de obtenção do GraphClient (registry + factory), no mesmo
 * padrão dos restantes providers do projeto (identidade, classificação,
 * requisitos, políticas).
 *
 * Seleção por variável de ambiente (default: fuseki):
 *   GRAPH_PROVIDER=fuseki
 *
 * Regras:
 *  - carregamento LAZY: nada é validado no arranque da aplicação; a
 *    configuração só é lida quando uma operação de grafo é pedida;
 *  - grafo ausente → GraphError graph_not_configured (o chamador decide como
 *    degradar; nenhuma operação atual depende do grafo);
 *  - provider desconhecido → GraphError graph_configuration_error;
 *  - o GraphClient NÃO é um provider de política e não pode ser consultado
 *    pelas políticas de reserva (guarda automatizada nos testes).
 *
 * Não instanciar clientes concretos fora deste módulo (exceto testes do
 * próprio módulo graph/).
 */
import type { GraphClient } from "./graphTypes.ts";
import { GraphError } from "./graphTypes.ts";
import type { GraphConfig } from "./graphConfig.ts";
import { DEFAULT_GRAPH_PROVIDER, loadGraphConfig } from "./graphConfig.ts";
import { SparqlHttpGraphClient } from "./sparqlHttpGraphClient.ts";

const registry: Record<string, (config: GraphConfig) => GraphClient> = {
    "fuseki": (config) => new SparqlHttpGraphClient(config),
};

let current: GraphClient | null = null;

/** True quando existe configuração completa de grafo no ambiente. */
export function isGraphConfigured(): boolean {
    try {
        return loadGraphConfig().configured;
    } catch {
        // configuração parcial/inválida: o grafo não está utilizável
        return false;
    }
}

export function getGraphClient(): GraphClient {
    if (current) return current;

    const name = (process.env.GRAPH_PROVIDER ?? "").trim() || DEFAULT_GRAPH_PROVIDER;
    const factory = registry[name];
    if (!factory) {
        throw new GraphError(
            "graph_configuration_error",
            `Unknown graph provider '${name}' for GRAPH_PROVIDER. Valid providers: ${Object.keys(registry).join(", ")}`
        );
    }

    const result = loadGraphConfig();
    if (!result.configured) {
        throw new GraphError("graph_not_configured", result.reason);
    }

    current = factory(result.config);
    return current;
}

/** Substituição controlada (testes). */
export function setGraphClient(client: GraphClient): void {
    current = client;
}

/** Volta a resolver a partir do ambiente (testes). */
export function resetGraphClient(): void {
    current = null;
}
