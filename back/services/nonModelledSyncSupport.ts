/**
 * Suporte partilhado da sincronização grafo→SQL dos ativos não modelados
 * (Prompt 5B): contexto do grafo operacional, hash canónico de payloads e
 * sanitização de erros. Nenhuma decisão de domínio vive aqui.
 */
import crypto from "node:crypto";
import type { GraphClient } from "../graph/graphTypes.ts";
import { GraphError } from "../graph/graphTypes.ts";
import { assertOperationalGraphWriteSafety, loadGraphConfig } from "../graph/graphConfig.ts";
import type { GraphConfig } from "../graph/graphConfig.ts";
import { getGraphClient } from "../graph/graphClientProvider.ts";
import { operationalGraphUri } from "../graph/namedGraphs.ts";
import { createSemanticUriFactory } from "../graph/semanticUriFactory.ts";
import type { SemanticUriFactory } from "../graph/semanticUriFactory.ts";
import { operationalVocabulary } from "../graph/operationalVocabulary.ts";
import type { OperationalVocabulary } from "../graph/operationalVocabulary.ts";
import { NonModelledAssetError } from "./nonModelledAssetTypes.ts";

export interface OperationalGraphContext {
    client: GraphClient;
    config: GraphConfig;
    vocab: OperationalVocabulary;
    uris: SemanticUriFactory;
    graphUri: string;
}

/**
 * Contexto para operações EXPLÍCITAS do grafo operacional. Lança
 * graph_not_configured quando o grafo não está configurado (as operações de
 * ativos não modelados são as únicas que dependem dele) e aplica a guarda de
 * produção ANTES de qualquer escrita.
 */
export function getOperationalGraphContext(): OperationalGraphContext {
    const result = loadGraphConfig();
    if (!result.configured) {
        throw new NonModelledAssetError(
            "graph_not_configured", 503,
            "The semantic graph is not configured — non-modelled asset operations are unavailable (the rest of the application is unaffected)"
        );
    }
    assertOperationalGraphWriteSafety(result.config);

    return {
        client: getGraphClient(),
        config: result.config,
        vocab: operationalVocabulary(result.config.baseUri),
        uris: createSemanticUriFactory(result.config.baseUri),
        graphUri: operationalGraphUri(result.config.baseUri),
    };
}

/** Hash canónico (SHA-256) do payload normalizado — deteção de reuso de chave. */
export function canonicalPayloadHash(payload: Record<string, unknown>): string {
    const canonical = JSON.stringify(payload, Object.keys(payload).sort());
    return crypto.createHash("sha256").update(canonical).digest("hex");
}

/** Erro sanitizado para persistir na operação (sem credenciais, tamanho limitado). */
export function sanitizeSyncError(error: unknown): { code: string; message: string } {
    if (error instanceof GraphError) {
        return { code: error.code, message: error.message.slice(0, 500) };
    }
    if (error instanceof NonModelledAssetError) {
        return { code: error.code, message: error.message.slice(0, 500) };
    }
    return { code: "unexpected_error", message: String((error as Error)?.message ?? error).slice(0, 500) };
}

/** Converte um GraphError numa resposta HTTP controlada (503/502). */
export function toHttpError(error: unknown): NonModelledAssetError {
    if (error instanceof NonModelledAssetError) return error;
    if (error instanceof GraphError) {
        const status = error.code === "graph_authentication_failed" || error.code === "graph_configuration_error" ? 502 : 503;
        return new NonModelledAssetError(error.code, status, `Semantic graph operation failed: ${error.message}`);
    }
    return new NonModelledAssetError("unexpected_error", 500, String((error as Error)?.message ?? error));
}
