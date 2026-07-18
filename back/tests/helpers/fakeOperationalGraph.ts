/**
 * Fake do GraphClient para os fluxos do grafo operacional (Prompt 5B).
 *
 * Segue a filosofia do fakeDb: em vez de um motor SPARQL completo, guarda os
 * triplos produzidos pelos INSERT DATA gerados por operationalStatements.ts
 * (formato previsível) e responde às FORMAS de query que os serviços usam.
 * Nenhum serviço real é contactado. Permite injetar falhas para os testes de
 * consistência distribuída.
 */
import type { GraphClient, GraphHealthResult, SparqlQueryResult } from "../../graph/graphTypes.ts";
import { GraphError } from "../../graph/graphTypes.ts";

export interface Triple { g: string; s: string; p: string; o: string }

function unescapeLiteral(value: string): string {
    return value
        .replace(/\\t/g, "\t").replace(/\\n/g, "\n").replace(/\\r/g, "\r")
        .replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function objectValue(raw: string): { type: "uri" | "literal"; value: string } {
    if (raw.startsWith("<")) return { type: "uri", value: raw.slice(1, -1) };
    const match = raw.match(/^"((?:[^"\\]|\\.)*)"/);
    return { type: "literal", value: unescapeLiteral(match?.[1] ?? "") };
}

export class FakeOperationalGraph implements GraphClient {
    readonly providerId = "fake-operational";
    triples: Triple[] = [];
    updateCalls: string[] = [];
    queryCalls: string[] = [];
    failNextUpdates = 0;
    failNextQueries = 0;

    reset(): void {
        this.triples = [];
        this.updateCalls = [];
        this.queryCalls = [];
        this.failNextUpdates = 0;
        this.failNextQueries = 0;
    }

    async healthCheck(): Promise<GraphHealthResult> {
        return { ok: true, provider: this.providerId, queryEndpoint: "fake", durationMs: 0, errorCode: null, error: null };
    }

    async putGraph(): Promise<void> {
        throw new GraphError("graph_update_failed", "fake: services must never PUT the whole operational graph");
    }

    async deleteGraph(): Promise<void> {
        throw new GraphError("graph_update_failed", "fake: services must never delete the operational graph");
    }

    async update(sparql: string): Promise<void> {
        this.updateCalls.push(sparql);
        if (this.failNextUpdates > 0) {
            this.failNextUpdates -= 1;
            throw new GraphError("graph_unavailable", "fake: injected update failure");
        }
        const block = sparql.match(/^INSERT DATA \{ GRAPH <([^>]+)> \{\n([\s\S]*)\n\} \}$/);
        if (!block) {
            throw new GraphError("graph_update_failed", `fake: unsupported update shape: ${sparql.slice(0, 80)}`);
        }
        const graph = block[1]!;
        for (const line of block[2]!.split("\n")) {
            const triple = line.match(/^<([^>]+)> <([^>]+)> (.+) \.$/);
            if (!triple) {
                throw new GraphError("graph_update_failed", `fake: unparseable triple line: ${line}`);
            }
            const candidate: Triple = { g: graph, s: triple[1]!, p: triple[2]!, o: triple[3]! };
            const duplicate = this.triples.some((t) =>
                t.g === candidate.g && t.s === candidate.s && t.p === candidate.p && t.o === candidate.o);
            if (!duplicate) this.triples.push(candidate);
        }
    }

    async query<T = any>(sparql: string): Promise<SparqlQueryResult<T>> {
        this.queryCalls.push(sparql);
        if (this.failNextQueries > 0) {
            this.failNextQueries -= 1;
            throw new GraphError("graph_unavailable", "fake: injected query failure");
        }

        const ask = sparql.match(/^ASK \{ GRAPH <([^>]+)> \{ <([^>]+)> \?p \?o \} \}$/);
        if (ask) {
            return { head: {}, boolean: this.triples.some((t) => t.g === ask[1] && t.s === ask[2]) } as any;
        }

        if (/SELECT \?uuid \?assignment \?space WHERE/.test(sparql)) {
            const subject = sparql.match(/\n<([^>]+)> <[^>]*assetUuid> \?uuid \./)?.[1];
            const uuid = this.literalOf(subject, "assetUuid");
            if (subject === undefined || uuid === null) return { head: {}, results: { bindings: [] } } as any;
            const current = this.currentAssignments(subject);
            const bindings = current.length === 0
                ? [{ uuid: { type: "literal", value: uuid } }]
                : current.map((c) => ({
                    uuid: { type: "literal", value: uuid },
                    assignment: { type: "uri", value: c.assignment },
                    space: { type: "uri", value: c.space },
                }));
            return { head: {}, results: { bindings } } as any;
        }

        if (/SELECT \?assignment \?space WHERE/.test(sparql)) {
            const subject = sparql.match(/\n<([^>]+)> <[^>]*hasLocationAssignment> \?assignment \./)?.[1];
            const bindings = subject === undefined ? [] : this.currentAssignments(subject).map((c) => ({
                assignment: { type: "uri", value: c.assignment },
                space: { type: "uri", value: c.space },
            }));
            return { head: {}, results: { bindings } } as any;
        }

        if (/SELECT \?asset \?uuid WHERE/.test(sparql)) {
            const assets = this.triples.filter((t) => t.p.endsWith("22-rdf-syntax-ns#type") && t.o.includes("NonModelledAsset"));
            const bindings = assets.map((t) => ({
                asset: { type: "uri", value: t.s },
                uuid: { type: "literal", value: this.literalOf(t.s, "assetUuid") ?? "" },
            }));
            return { head: {}, results: { bindings } } as any;
        }

        if (/SELECT \?name \?assetType \?resourceKind/.test(sparql)) {
            const subject = sparql.match(/\n<([^>]+)> <[^>]*displayName> \?name \./)?.[1];
            if (subject === undefined) return { head: {}, results: { bindings: [] } } as any;
            const binding: Record<string, any> = {};
            const map: Record<string, string> = {
                name: "displayName", assetType: "assetType", resourceKind: "resourceKind",
                assetCode: "assetCode", serialNumber: "serialNumber",
            };
            for (const [variable, term] of Object.entries(map)) {
                const value = this.literalOf(subject, term);
                if (value !== null) binding[variable] = { type: "literal", value };
            }
            return { head: {}, results: { bindings: binding.name ? [binding] : [] } } as any;
        }

        if (/^ASK \{\}$/.test(sparql.trim())) {
            return { head: {}, boolean: true } as any;
        }

        throw new GraphError("graph_query_failed", `fake: unsupported query shape: ${sparql.slice(0, 80)}`);
    }

    /* ------------------------------------------------------------------ */

    literalOf(subject: string | undefined, termSuffix: string): string | null {
        if (subject === undefined) return null;
        const triple = this.triples.find((t) => t.s === subject && t.p.endsWith(`#${termSuffix}`));
        if (!triple) return null;
        return objectValue(triple.o).value;
    }

    currentAssignments(assetUri: string): { assignment: string; space: string }[] {
        const assignments = this.triples
            .filter((t) => t.s === assetUri && t.p.endsWith("#hasLocationAssignment"))
            .map((t) => objectValue(t.o).value);
        return assignments
            .filter((a) => !this.triples.some((t) => t.s === a && t.p.endsWith("#validTo")))
            .map((a) => ({
                assignment: a,
                space: objectValue(this.triples.find((t) => t.s === a && t.p.endsWith("#assignedSpace"))?.o ?? "<>").value,
            }));
    }

    triplesOf(subject: string): Triple[] {
        return this.triples.filter((t) => t.s === subject);
    }
}
