/**
 * Reconciliação grafo–SQL dos ativos NÃO modelados (Prompt 5B; ADR-0029).
 *
 * Compara a AUTORIDADE (grafo operacional) com a projeção SQL e classifica
 * divergências. Dois modos:
 *  - report(): só leitura, nunca escreve;
 *  - applySafe(): corrige APENAS casos seguros e é idempotente —
 *      · recria projeção SQL ausente a partir do grafo;
 *      · retoma operações de sincronização incompletas;
 *      · atualiza a localização SQL quando o grafo tem EXATAMENTE UMA
 *        atribuição corrente inequívoca.
 *    NUNCA corrige: ativos SQL cuja origem não é o grafo (nem sequer são
 *    lidos), múltiplas localizações correntes no grafo, divergências de
 *    UUID/URI, projeções órfãs — esses são apenas reportados (decisão
 *    humana; corrigir automaticamente poderia apagar histórico).
 *
 * NÃO é executada automaticamente em pedidos de reserva nem em scheduler —
 * é acionada por endpoint/script administrativo.
 */
import crypto from "node:crypto";
import nonModelledDb from "../utils/nonModelledAssetDatabase.ts";
import registrationService from "./nonModelledAssetRegistrationService.ts";
import locationService from "./nonModelledAssetLocationService.ts";
import { getReservabilityEvaluator, logPolicyDecision } from "../policies/policyProvider.ts";
import {
    buildAllNonModelledAssetsSelect,
    buildAssetDescriptionSelect,
    buildCurrentAssignmentsSelect,
} from "../graph/operationalStatements.ts";
import { getOperationalGraphContext, toHttpError, type OperationalGraphContext } from "./nonModelledSyncSupport.ts";

export interface ReconciliationFinding {
    type:
        | "graph_asset_missing_sql_projection"
        | "sql_projection_missing_graph_asset"
        | "semantic_uri_mismatch"
        | "asset_uuid_mismatch"
        | "current_location_mismatch"
        | "multiple_current_graph_locations"
        | "multiple_current_sql_locations"
        | "missing_location_projection"
        | "orphan_location_projection"
        | "incomplete_sync_operation";
    assetUuid: string | null;
    assetUri: string | null;
    safeToApply: boolean;
    details: string;
}

export interface ReconciliationReport {
    generatedAt: string;
    graphAssetCount: number;
    sqlProjectionCount: number;
    findings: ReconciliationFinding[];
}

interface GraphAssetState {
    assetUri: string;
    assetUuid: string;
    currentAssignments: { assignmentUri: string; spaceUri: string }[];
}

class GraphSqlReconciliationService {

    /** Modo relatório — NUNCA escreve (nem no grafo nem no SQL). */
    async report(): Promise<ReconciliationReport> {
        const ctx = getOperationalGraphContext();
        const graphAssets = await this.readGraphAssets(ctx);
        const sqlAssets = await nonModelledDb.listGraphAssets();
        const sqlCurrents = await nonModelledDb.listCurrentAssignmentsForGraphAssets();
        const incompleteOps = await nonModelledDb.listIncompleteOperations();

        const findings: ReconciliationFinding[] = [];
        const sqlByUuid = new Map<string, any>(sqlAssets.map((a: any) => [a.asset_uuid, a]));
        const graphByUuid = new Map<string, GraphAssetState>(graphAssets.map((g) => [g.assetUuid, g]));
        const sqlCurrentByUuid = new Map<string, any[]>();
        for (const row of sqlCurrents) {
            const list = sqlCurrentByUuid.get(row.asset_uuid) ?? [];
            list.push(row);
            sqlCurrentByUuid.set(row.asset_uuid, list);
        }

        for (const graphAsset of graphAssets) {
            const expectedUri = ctx.uris.assetUri(graphAsset.assetUuid);
            if (graphAsset.assetUri !== expectedUri) {
                findings.push({
                    type: "asset_uuid_mismatch", assetUuid: graphAsset.assetUuid, assetUri: graphAsset.assetUri,
                    safeToApply: false,
                    details: `graph asset URI does not match its UUID (expected ${expectedUri}) — human decision required`,
                });
                continue;
            }

            const sqlAsset = sqlByUuid.get(graphAsset.assetUuid);
            if (!sqlAsset) {
                findings.push({
                    type: "graph_asset_missing_sql_projection", assetUuid: graphAsset.assetUuid, assetUri: graphAsset.assetUri,
                    safeToApply: true,
                    details: "asset exists in the operational graph but has no SQL projection — safe to recreate from the graph",
                });
                continue;
            }

            if (sqlAsset.semantic_uri !== graphAsset.assetUri) {
                findings.push({
                    type: "semantic_uri_mismatch", assetUuid: graphAsset.assetUuid, assetUri: graphAsset.assetUri,
                    safeToApply: false,
                    details: `SQL projection semantic_uri='${sqlAsset.semantic_uri}' differs from graph URI — human decision required`,
                });
            }

            if (graphAsset.currentAssignments.length > 1) {
                findings.push({
                    type: "multiple_current_graph_locations", assetUuid: graphAsset.assetUuid, assetUri: graphAsset.assetUri,
                    safeToApply: false,
                    details: `graph has ${graphAsset.currentAssignments.length} current location assignments — inconsistent authority state, never auto-fixed`,
                });
                continue;
            }

            const sqlCurrent = sqlCurrentByUuid.get(graphAsset.assetUuid) ?? [];
            if (sqlCurrent.length > 1) {
                findings.push({
                    type: "multiple_current_sql_locations", assetUuid: graphAsset.assetUuid, assetUri: graphAsset.assetUri,
                    safeToApply: false,
                    details: `SQL projection has ${sqlCurrent.length} current assignments — schema guarantees should prevent this; human decision required`,
                });
                continue;
            }

            const graphCurrent = graphAsset.currentAssignments[0] ?? null;
            const projectedCurrent = sqlCurrent[0] ?? null;

            if (graphCurrent && !projectedCurrent) {
                findings.push({
                    type: "missing_location_projection", assetUuid: graphAsset.assetUuid, assetUri: graphAsset.assetUri,
                    safeToApply: true,
                    details: "graph has a current location but SQL has none — safe to project the unambiguous graph location",
                });
            } else if (!graphCurrent && projectedCurrent) {
                findings.push({
                    type: "orphan_location_projection", assetUuid: graphAsset.assetUuid, assetUri: graphAsset.assetUri,
                    safeToApply: false,
                    details: "SQL has a current location but the graph (authority) has none — reported only, closing SQL history automatically could hide an authority problem",
                });
            } else if (graphCurrent && projectedCurrent) {
                const projectedSpaceUri = ctx.uris.spaceUri(projectedCurrent.space_uuid);
                if (projectedSpaceUri !== graphCurrent.spaceUri) {
                    findings.push({
                        type: "current_location_mismatch", assetUuid: graphAsset.assetUuid, assetUri: graphAsset.assetUri,
                        safeToApply: true,
                        details: `SQL current space (${projectedSpaceUri}) differs from graph current space (${graphCurrent.spaceUri}) — graph is unambiguous, safe to update the SQL projection`,
                    });
                }
            }
        }

        for (const sqlAsset of sqlAssets) {
            if (sqlAsset.asset_uuid && !graphByUuid.has(sqlAsset.asset_uuid)) {
                findings.push({
                    type: "sql_projection_missing_graph_asset", assetUuid: sqlAsset.asset_uuid, assetUri: sqlAsset.semantic_uri,
                    safeToApply: false,
                    details: `SQL projection (asset ${sqlAsset.id}) has no corresponding asset in the operational graph — a SQL row is NOT sufficient proof of semantic existence; human decision required`,
                });
            }
        }

        for (const op of incompleteOps) {
            findings.push({
                type: "incomplete_sync_operation", assetUuid: op.asset_uuid, assetUri: op.asset_uri,
                safeToApply: op.status !== "pending_graph",
                details: `operation ${op.operation_uuid} (${op.operation_type}) is '${op.status}' after ${op.attempt_count} attempt(s)${op.last_error_code ? ` — last error ${op.last_error_code}` : ""}`,
            });
        }

        return {
            generatedAt: new Date().toISOString(),
            graphAssetCount: graphAssets.length,
            sqlProjectionCount: sqlAssets.length,
            findings,
        };
    }

    /** Aplica APENAS correções seguras; idempotente (2.ª execução → nada a fazer). */
    async applySafe(): Promise<{ applied: ReconciliationFinding[]; skipped: ReconciliationFinding[]; report: ReconciliationReport }> {
        const before = await this.report();
        const ctx = getOperationalGraphContext();
        const applied: ReconciliationFinding[] = [];
        const skipped: ReconciliationFinding[] = [];

        for (const finding of before.findings) {
            if (!finding.safeToApply) {
                skipped.push(finding);
                continue;
            }
            try {
                switch (finding.type) {
                    case "graph_asset_missing_sql_projection":
                        await this.recreateProjectionFromGraph(ctx, finding.assetUuid!, finding.assetUri!);
                        break;
                    case "missing_location_projection":
                    case "current_location_mismatch":
                        await this.projectGraphLocation(ctx, finding.assetUuid!, finding.assetUri!);
                        break;
                    case "incomplete_sync_operation":
                        await this.resumeIncompleteOperations(finding.assetUuid);
                        break;
                    default:
                        skipped.push(finding);
                        continue;
                }
                applied.push(finding);
            } catch (error) {
                skipped.push({ ...finding, details: `${finding.details} | apply failed: ${(error as Error).message.slice(0, 200)}` });
            }
        }

        return { applied, skipped, report: await this.report() };
    }

    /* ------------------------------------------------------------------ */

    private async readGraphAssets(ctx: OperationalGraphContext): Promise<GraphAssetState[]> {
        let assets: GraphAssetState[] = [];
        try {
            const result = await ctx.client.query(buildAllNonModelledAssetsSelect(ctx.vocab, ctx.graphUri));
            const bindings = result.results?.bindings ?? [];
            assets = bindings.map((b: any) => ({
                assetUri: b.asset.value,
                assetUuid: b.uuid.value,
                currentAssignments: [] as { assignmentUri: string; spaceUri: string }[],
            }));
            for (const asset of assets) {
                const current = await ctx.client.query(
                    buildCurrentAssignmentsSelect(ctx.vocab, ctx.graphUri, asset.assetUri));
                asset.currentAssignments = (current.results?.bindings ?? []).map((b: any) => ({
                    assignmentUri: b.assignment.value,
                    spaceUri: b.space.value,
                }));
            }
        } catch (error) {
            throw toHttpError(error);
        }
        return assets;
    }

    /** Recria a projeção SQL a partir da autoridade (grafo). */
    private async recreateProjectionFromGraph(ctx: OperationalGraphContext, assetUuid: string, assetUri: string): Promise<void> {
        const description = await ctx.client.query(buildAssetDescriptionSelect(ctx.vocab, ctx.graphUri, assetUri));
        const d: any = description.results?.bindings?.[0];
        if (!d) throw new Error("graph asset description unavailable");

        const resourceKind = d.resourceKind?.value === "tool" ? "tool" : "equipment";
        const decision = await getReservabilityEvaluator().evaluate({
            candidateKind: "non_modelled_asset",
            entityType: "element",
            name: d.name?.value ?? assetUuid,
            assetType: d.assetType?.value ?? null,
            resourceKind,
            source: "graph",
            managerCode: d.assetCode?.value ?? null,
            serialNumber: d.serialNumber?.value ?? null,
        }, {});
        logPolicyDecision("non_modelled_reservability", decision, { assetUuid, stageDetail: "reconciliation_recreate" });

        await nonModelledDb.projectRegistration({
            assetUuid,
            assetUri,
            name: d.name?.value ?? assetUuid,
            resourceKind,
            assetSubtype: d.assetType?.value ?? "Unknown",
            managerCode: d.assetCode?.value ?? null,
            serialNumber: d.serialNumber?.value ?? null,
            reservable: decision.decision === "allow",
            assignment: null,
        });
        await this.projectGraphLocation(ctx, assetUuid, assetUri);
    }

    /** Projeta no SQL a localização corrente INEQUÍVOCA do grafo. */
    private async projectGraphLocation(ctx: OperationalGraphContext, assetUuid: string, assetUri: string): Promise<void> {
        const current = await ctx.client.query(buildCurrentAssignmentsSelect(ctx.vocab, ctx.graphUri, assetUri));
        const bindings = current.results?.bindings ?? [];
        if (bindings.length !== 1) return; // 0 = nada a projetar; >1 = nunca automático

        const assignmentUri = (bindings[0] as any).assignment.value as string;
        const spaceUri = (bindings[0] as any).space.value as string;
        const assignmentUuid = assignmentUri.split("/").pop()!;
        const spaceUuid = spaceUri.split("/").pop()!;

        const asset = await nonModelledDb.findAssetByUuid(assetUuid);
        if (!asset) return;
        const space = await nonModelledDb.findSpaceByUuid(spaceUuid);
        if (!space) return; // espaço não projetável — fica no relatório seguinte

        const sqlCurrent = await nonModelledDb.getCurrentAssignment(asset.id);
        if (sqlCurrent?.assignment_uuid === assignmentUuid) {
            // mesma atribuição: realinhar o espaço se a projeção divergir da autoridade
            if (sqlCurrent.space_id !== space.id) {
                await nonModelledDb.realignAssignmentSpace(assignmentUuid, space.id);
            }
            return;
        }

        await nonModelledDb.projectMovement({
            assetId: asset.id,
            closedAssignmentUuid: sqlCurrent?.assignment_uuid ?? crypto.randomUUID(), // sem corrente: o UPDATE é no-op
            closedAtIso: new Date().toISOString(),
            newAssignment: {
                assignmentUuid,
                assertionUri: assignmentUri,
                spaceId: space.id,
                source: "manual",
                validFromIso: new Date().toISOString(),
                provenanceActivityUri: null,
            },
        });
    }

    /** Retoma operações incompletas (retryable) — nunca as pending_graph órfãs. */
    private async resumeIncompleteOperations(assetUuid: string | null): Promise<void> {
        const ops = await nonModelledDb.listIncompleteOperations();
        for (const op of ops) {
            if (assetUuid && op.asset_uuid !== assetUuid) continue;
            if (op.status === "pending_graph") continue; // exige retry explícito/diagnóstico
            // attempt_count é incrementado dentro de resumeOperation
            if (op.operation_type === "register_asset") {
                await registrationService.resumeOperation(op);
            } else {
                await locationService.resumeOperation(op);
            }
        }
    }
}

export default new GraphSqlReconciliationService();
