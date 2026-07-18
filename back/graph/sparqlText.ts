/**
 * Construção SEGURA de texto SPARQL/Turtle (Prompt 5B).
 *
 * Toda a serialização de IRIs e literais para o grafo passa por aqui —
 * nenhuma concatenação direta de input do utilizador em SPARQL é permitida
 * fora deste módulo (guarda automatizada nos testes). Isto elimina SPARQL
 * injection por construção: literais são escapados, IRIs são validadas.
 */
import { GraphError } from "./graphTypes.ts";

/** Caracteres proibidos num IRIREF SPARQL: controlo (U+0000..U+0020) e <>"{}|^`\ . */
const IRI_FORBIDDEN = new RegExp("[\\u0000-\\u0020<>\"{}|^`\\\\]");

/** Valida e serializa um IRI absoluto como `<...>`. */
export function iri(value: string): string {
    if (typeof value !== "string" || value.trim() === "" || IRI_FORBIDDEN.test(value)) {
        throw new GraphError("graph_update_failed", `invalid IRI for graph statement: '${String(value)}'`);
    }
    try {
        // exige IRI absoluto (esquema + resto)
        new URL(value);
    } catch {
        throw new GraphError("graph_update_failed", `IRI must be absolute: '${value}'`);
    }
    return `<${value}>`;
}

/** Escapa o conteúdo de um literal (aspas, backslash, quebras de linha). */
function escapeLiteral(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t");
}

/** Literal string simples. */
export function stringLiteral(value: string): string {
    if (typeof value !== "string") {
        throw new GraphError("graph_update_failed", "string literal must be a string");
    }
    return `"${escapeLiteral(value)}"`;
}

const XSD = "http://www.w3.org/2001/XMLSchema#";

/** Literal xsd:dateTime a partir de uma data ISO 8601 (valida e normaliza). */
export function dateTimeLiteral(value: string | Date): string {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new GraphError("graph_update_failed", `invalid dateTime for graph statement: '${String(value)}'`);
    }
    return `"${date.toISOString()}"^^<${XSD}dateTime>`;
}

/** Literal xsd:decimal (confiança 0..1, etc.). */
export function decimalLiteral(value: number): string {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new GraphError("graph_update_failed", `invalid decimal for graph statement: '${String(value)}'`);
    }
    return `"${value}"^^<${XSD}decimal>`;
}
