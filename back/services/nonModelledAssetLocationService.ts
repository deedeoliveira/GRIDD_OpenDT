/**
 * Movimento de ativos NÃO modelados (Prompt 5B; ADR-0028).
 *
 * Invariante central: mover NUNCA muda a identidade —
 *   ativo na Sala X → movido para a Sala Y
 *   ⇒ mesmo asset_id, mesmo asset_uuid, MESMA asset URI.
 * O movimento encerra a atribuição corrente (INSERE validTo — nunca apaga)
 * e cria uma NOVA atribuição; o histórico é preservado no grafo e no SQL.
 *
 * Fontes: nesta etapa apenas 'manual' é aceite via API — sensor_inference e
 * external_system são futuros e um cliente comum não pode declará-los.
 */
import crypto from "node:crypto";
import nonModelledDb from "../utils/nonModelledAssetDatabase.ts";
import type { SyncOperationRow } from "../utils/nonModelledAssetDatabase.ts";
import {
    buildCurrentAssignmentsSelect,
    buildMovementInsert,
    buildResourceExistsAsk,
} from "../graph/operationalStatements.ts";
import {
    IMPLEMENTED_LOCATION_SOURCES,
    NonModelledAssetError,
    type MoveNonModelledAssetCommand,
} from "./nonModelledAssetTypes.ts";
import {
    canonicalPayloadHash,
    getOperationalGraphContext,
    sanitizeSyncError,
    toHttpError,
    type OperationalGraphContext,
} from "./nonModelledSyncSupport.ts";

interface NormalizedMovement {
    assetId: number;
    newSpaceId: number;
    source: string;
}

export interface MovementResult {
    assetId: number;
    assetUuid: string;
    assetUri: string;
    closedAssignmentUuid: string | null;
    newAssignment: {
        assignmentUuid: string;
        spaceId: number;
        validFrom: string;
    };
    operation: { id: number | null; operationUuid: string; status: string; attemptCount: number };
}

function normalizeCommand(command: MoveNonModelledAssetCommand): NormalizedMovement {
    if (typeof command.movementKey !== "string" || command.movementKey.trim() === "" || command.movementKey.length > 200) {
        throw new NonModelledAssetError("validation_error", 400, "movementKey is required (non-empty string, max 200 chars)");
    }
    const assetId = Number(command.assetId);
    const newSpaceId = Number(command.newSpaceId);
    if (!Number.isInteger(assetId) || assetId <= 0) {
        throw new NonModelledAssetError("validation_error", 400, "assetId must be a positive integer");
    }
    if (!Number.isInteger(newSpaceId) || newSpaceId <= 0) {
        throw new NonModelledAssetError("validation_error", 400, "newSpaceId must be a positive integer");
    }
    const source = command.source ?? "manual";
    if (!IMPLEMENTED_LOCATION_SOURCES.includes(source as any)) {
        throw new NonModelledAssetError(
            "source_not_implemented", 422,
            `location source '${source}' is not accepted in this stage — only 'manual' is implemented (sensor_inference/external_system are future work and cannot be declared by API clients)`
        );
    }
    return { assetId, newSpaceId, source };
}

class NonModelledAssetLocationService {

    async move(command: MoveNonModelledAssetCommand): Promise<MovementResult> {
        const normalized = normalizeCommand(command);
        const movementKey = command.movementKey.trim();
        const payloadHash = canonicalPayloadHash({
            assetId: normalized.assetId,
            newSpaceId: normalized.newSpaceId,
            source: normalized.source,
        });

        const existing = await nonModelledDb.findOperationByKey("move_asset", movementKey);
        if (existing) {
            if (existing.payload_hash !== payloadHash) {
                throw new NonModelledAssetError(
                    "idempotency_conflict", 409,
                    "movementKey was already used with a different payload — use a new key for a new command"
                );
            }
            if (existing.status === "failed_terminal") {
                throw new NonModelledAssetError(
                    "operation_failed_terminal", 409,
                    `Operation ${existing.operation_uuid} failed terminally (${existing.last_error_code ?? "unknown"})`
                );
            }
            return this.resumeOperation(existing);
        }

        const asset = await this.assertMovableAsset(normalized.assetId);
        const space = await this.assertTargetSpace(normalized.newSpaceId);
        const ctx = getOperationalGraphContext();

        // atribuição corrente segundo a AUTORIDADE (grafo)
        const currentUri = await this.queryCurrentAssignmentUri(ctx, asset.semantic_uri);

        const operationUuid = crypto.randomUUID();
        const assignmentUuid = crypto.randomUUID();

        await nonModelledDb.createOperation({
            operationUuid,
            idempotencyKey: movementKey,
            operationType: "move_asset",
            payloadJson: JSON.stringify(normalized),
            payloadHash,
            assetUuid: asset.asset_uuid,
            assetUri: asset.semantic_uri,
            locationAssignmentUuid: assignmentUuid,
            locationAssignmentUri: ctx.uris.locationAssignmentUri(assignmentUuid),
            closedAssignmentUuid: this.uuidFromAssignmentUri(currentUri),
        });

        const operation = await nonModelledDb.findOperationByKey("move_asset", movementKey);
        return this.executeMovement(operation!, normalized, ctx);
    }

    async resumeOperation(operation: SyncOperationRow): Promise<MovementResult> {
        if (operation.status === "completed") {
            // já concluída: devolve o resultado existente SEM nova tentativa
            return this.buildResult(operation);
        }
        // tentativa REAL de reexecução → incrementa o contador (ponto único)
        await nonModelledDb.incrementOperationAttempt(operation.operation_uuid);
        operation.attempt_count += 1;

        const normalized: NormalizedMovement = JSON.parse(operation.payload_json ?? "{}");
        const ctx = getOperationalGraphContext();
        return this.executeMovement(operation, normalized, ctx);
    }

    /* ------------------------------------------------------------------ */

    private async assertMovableAsset(assetId: number): Promise<any> {
        const asset = await nonModelledDb.findAssetById(assetId);
        if (!asset) {
            throw new NonModelledAssetError("asset_not_found", 404, `Asset ${assetId} not found`);
        }
        if (asset.source !== "graph") {
            throw new NonModelledAssetError(
                "not_a_non_modelled_asset", 422,
                `Asset ${assetId} is not graph-sourced (source='${asset.source}') — modelled assets keep their location in IFC bindings and are NOT moved by this service`
            );
        }
        if (!asset.asset_uuid || !asset.semantic_uri) {
            throw new NonModelledAssetError("asset_projection_incomplete", 409, `Asset ${assetId} projection lacks asset_uuid/semantic_uri`);
        }
        if (asset.lifecycle_status !== "active") {
            throw new NonModelledAssetError("asset_not_active", 422, `Asset ${assetId} lifecycle is '${asset.lifecycle_status}'`);
        }
        return asset;
    }

    private async assertTargetSpace(spaceId: number): Promise<any> {
        const space = await nonModelledDb.getSpaceById(spaceId);
        if (!space) {
            throw new NonModelledAssetError("space_not_found", 422, `newSpaceId ${spaceId} does not exist`);
        }
        if (!space.space_uuid) {
            throw new NonModelledAssetError("space_not_persistent", 422, `newSpaceId ${spaceId} has no persistent identity`);
        }
        if (space.status !== "active") {
            throw new NonModelledAssetError(
                "space_not_active", 422,
                `newSpaceId ${spaceId} is '${space.status}' — an absent/retired space cannot receive assets`
            );
        }
        return space;
    }

    /** Atribuição corrente no GRAFO; 0 ou >1 são estados que impedem movimento. */
    private async queryCurrentAssignmentUri(ctx: OperationalGraphContext, assetUri: string): Promise<string> {
        let bindings: any[];
        try {
            const result = await ctx.client.query(buildCurrentAssignmentsSelect(ctx.vocab, ctx.graphUri, assetUri));
            bindings = result.results?.bindings ?? [];
        } catch (error) {
            throw toHttpError(error);
        }

        if (bindings.length === 0) {
            throw new NonModelledAssetError(
                "no_current_location", 409,
                "asset has no current location assignment in the operational graph — movement requires a current location (pending_location assets need diagnosis/reconciliation, not movement)"
            );
        }
        if (bindings.length > 1) {
            throw new NonModelledAssetError(
                "multiple_current_locations", 409,
                "asset has MULTIPLE current location assignments in the operational graph — inconsistent state; run graph–SQL reconciliation before moving"
            );
        }
        return bindings[0].assignment.value;
    }

    private uuidFromAssignmentUri(assignmentUri: string): string {
        const tail = assignmentUri.split("/").pop() ?? "";
        return tail;
    }

    private async executeMovement(
        operation: SyncOperationRow,
        normalized: NormalizedMovement,
        ctx: OperationalGraphContext
    ): Promise<MovementResult> {
        const asset = await this.assertMovableAsset(normalized.assetId);
        const space = await this.assertTargetSpace(normalized.newSpaceId);
        const activityUri = ctx.uris.provenanceActivityUri(operation.operation_uuid);
        const closedAssignmentUri = ctx.uris.locationAssignmentUri(operation.closed_assignment_uuid!);

        /* -------- fase 1: grafo (autoridade) -------- */
        if (operation.status === "pending_graph" || operation.status === "failed_retryable") {
            try {
                const exists = await ctx.client.query(
                    buildResourceExistsAsk(ctx.graphUri, operation.location_assignment_uri!));
                if (exists.boolean !== true) {
                    const nowIso = new Date().toISOString();
                    await ctx.client.update(buildMovementInsert(ctx.vocab, ctx.graphUri, {
                        assetUri: operation.asset_uri!,
                        closedAssignmentUri,
                        closedAtIso: nowIso,
                        newAssignment: {
                            assignmentUri: operation.location_assignment_uri!,
                            spaceUri: ctx.uris.spaceUri(space.space_uuid),
                            validFromIso: nowIso,
                            source: normalized.source,
                        },
                        activityUri,
                        createdAtIso: nowIso,
                    }));
                }

                // verificação: a ÚNICA atribuição corrente é agora a nova
                const current = await ctx.client.query(
                    buildCurrentAssignmentsSelect(ctx.vocab, ctx.graphUri, operation.asset_uri!));
                const bindings = current.results?.bindings ?? [];
                const ok = bindings.length === 1
                    && bindings[0]?.assignment?.value === operation.location_assignment_uri
                    && bindings[0]?.space?.value === ctx.uris.spaceUri(space.space_uuid);
                if (!ok) {
                    throw new NonModelledAssetError(
                        "graph_verification_failed", 502,
                        "graph write verification failed: new assignment is not the single current location"
                    );
                }

                await nonModelledDb.setOperationStatus(operation.operation_uuid, "graph_written", null);
                operation.status = "graph_written";
            } catch (error) {
                await nonModelledDb.setOperationStatus(operation.operation_uuid, "failed_retryable", sanitizeSyncError(error));
                throw toHttpError(error);
            }
        }

        /* -------- fase 2: projeção SQL (transacional, idempotente) -------- */
        if (operation.status === "graph_written" || operation.status === "pending_sql_projection") {
            try {
                await nonModelledDb.setOperationStatus(operation.operation_uuid, "pending_sql_projection", null);
                await nonModelledDb.projectMovement({
                    assetId: asset.id,
                    closedAssignmentUuid: operation.closed_assignment_uuid!,
                    closedAtIso: new Date().toISOString(),
                    newAssignment: {
                        assignmentUuid: operation.location_assignment_uuid!,
                        assertionUri: operation.location_assignment_uri!,
                        spaceId: space.id,
                        source: normalized.source,
                        validFromIso: new Date().toISOString(),
                        provenanceActivityUri: activityUri,
                    },
                });
                await nonModelledDb.setOperationStatus(operation.operation_uuid, "completed", null);
                operation.status = "completed";
            } catch (error) {
                await nonModelledDb.setOperationStatus(operation.operation_uuid, "pending_sql_projection", sanitizeSyncError(error));
                throw toHttpError(error);
            }
        }

        return this.buildResult(operation);
    }

    private async buildResult(operation: SyncOperationRow): Promise<MovementResult> {
        const asset = await nonModelledDb.findAssetByUuid(operation.asset_uuid!);
        const current = asset ? await nonModelledDb.getCurrentAssignment(asset.id) : null;

        return {
            assetId: asset?.id ?? 0,
            assetUuid: operation.asset_uuid!,
            assetUri: operation.asset_uri!,
            closedAssignmentUuid: operation.closed_assignment_uuid ?? null,
            newAssignment: {
                assignmentUuid: operation.location_assignment_uuid!,
                spaceId: current?.space_id ?? 0,
                validFrom: current ? new Date(current.valid_from).toISOString() : "",
            },
            operation: {
                id: operation.id ?? null,
                operationUuid: operation.operation_uuid,
                status: operation.status,
                attemptCount: operation.attempt_count,
            },
        };
    }
}

export default new NonModelledAssetLocationService();
