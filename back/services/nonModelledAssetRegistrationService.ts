/**
 * Registo de ativos NÃO modelados (Prompt 5B; ADR-0025/0026/0027).
 *
 * Fluxo (máquina de estados em semantic_sync_operations):
 *   comando → validação → operação 'pending_graph' → escrita no grafo
 *   operacional (INSERT DATA dirigido, ASK-guardado) → verificação por query
 *   → 'graph_written' → política de reservabilidade (provider configurado,
 *   NUNCA reservable=true fixo) → projeção SQL transacional →
 *   'completed'.
 *
 * Consistência distribuída (sem transação conjunta MySQL↔Fuseki — nunca
 * alegada): falha no grafo ⇒ nenhum asset SQL é criado (failed_retryable);
 * falha no SQL após o grafo ⇒ o grafo permanece autoridade e a operação fica
 * 'pending_sql_projection'; retry reutiliza SEMPRE os mesmos UUIDs/URIs.
 *
 * Idempotência: (operation_type, registrationKey) é único; mesma chave +
 * mesmo payload ⇒ mesmo resultado; mesma chave + payload diferente ⇒ 409.
 */
import crypto from "node:crypto";
import nonModelledDb from "../utils/nonModelledAssetDatabase.ts";
import { isDuplicateKeyError, logConcurrencyEvent } from "../utils/concurrencyControl.ts";
import type { SyncOperationRow } from "../utils/nonModelledAssetDatabase.ts";
import { getReservabilityEvaluator, logPolicyDecision } from "../policies/policyProvider.ts";
import {
    buildRegistrationInsert,
    buildRegistrationVerificationSelect,
    buildResourceExistsAsk,
} from "../graph/operationalStatements.ts";
import {
    NonModelledAssetError,
    type NonModelledAssetResult,
    type RegisterNonModelledAssetCommand,
} from "./nonModelledAssetTypes.ts";
import {
    canonicalPayloadHash,
    getOperationalGraphContext,
    sanitizeSyncError,
    toHttpError,
    type OperationalGraphContext,
} from "./nonModelledSyncSupport.ts";

const SOURCE_SYSTEM = "oswadt-api";

interface NormalizedRegistration {
    name: string;
    assetType: string;
    resourceKind: "equipment" | "tool";
    managerCode: string | null;
    serialNumber: string | null;
    initialSpaceId: number | null;
}

export interface RegistrationRecoveryResult {
    originalOperationUuid: string;
    recoveryOperationUuid: string;
    assetUuid: string;
    assetUri: string;
    graphUri: string;
    graphWasRestored: boolean;
}

function normalizeCommand(command: RegisterNonModelledAssetCommand): NormalizedRegistration {
    if (typeof command.registrationKey !== "string" || command.registrationKey.trim() === "" || command.registrationKey.length > 200) {
        throw new NonModelledAssetError("validation_error", 400, "registrationKey is required (non-empty string, max 200 chars)");
    }
    if (typeof command.name !== "string" || command.name.trim() === "") {
        throw new NonModelledAssetError("validation_error", 400, "name is required");
    }
    if (typeof command.assetType !== "string" || command.assetType.trim() === "") {
        throw new NonModelledAssetError("validation_error", 400, "assetType is required (free-form project type, e.g. 'PortableEquipment')");
    }
    if (command.resourceKind !== "equipment" && command.resourceKind !== "tool") {
        throw new NonModelledAssetError("validation_error", 400, "resourceKind must be 'equipment' or 'tool'");
    }
    const managerCode = command.managerCode == null ? null : String(command.managerCode).trim();
    if (managerCode === "") {
        throw new NonModelledAssetError("validation_error", 400, "managerCode, when provided, must not be empty (omit it instead — it is optional)");
    }
    const serialNumber = command.serialNumber == null ? null : String(command.serialNumber).trim() || null;

    let initialSpaceId: number | null = null;
    if (command.initialSpaceId !== undefined && command.initialSpaceId !== null) {
        initialSpaceId = Number(command.initialSpaceId);
        if (!Number.isInteger(initialSpaceId) || initialSpaceId <= 0) {
            throw new NonModelledAssetError("validation_error", 400, "initialSpaceId, when provided, must be a positive integer");
        }
    }

    return {
        name: command.name.trim(),
        assetType: command.assetType.trim(),
        resourceKind: command.resourceKind,
        managerCode,
        serialNumber,
        initialSpaceId,
    };
}

function registrationPayloadHash(n: NormalizedRegistration): string {
    return canonicalPayloadHash({
        assetType: n.assetType,
        initialSpaceId: n.initialSpaceId,
        managerCode: n.managerCode,
        name: n.name,
        resourceKind: n.resourceKind,
        serialNumber: n.serialNumber,
    });
}

class NonModelledAssetRegistrationService {

    /**
     * Reconstitui no grafo uma operação de registo já concluída que perdeu a
     * sua autoridade semântica. A fonte é exclusivamente o comando canónico
     * append-only: a projeção SQL serve apenas para confirmar que continua a
     * apontar para a mesma identidade, nunca para construir RDF.
     *
     * A recuperação é registada como uma nova operação `register_asset`, com
     * chave formal derivada da operação original. O schema atual restringe o
     * tipo a `register_asset|move_asset`; o payload de recuperação preserva a
     * ligação inequívoca ao comando original sem alterar esse contrato.
     */
    async recoverCompletedRegistration(original: SyncOperationRow): Promise<RegistrationRecoveryResult> {
        if (original.operation_type !== "register_asset" || original.status !== "completed") {
            throw new NonModelledAssetError("recovery_not_eligible", 409,
                "only a completed register_asset operation can be recovered from its canonical command log");
        }
        if (!original.asset_uuid || !original.asset_uri || !original.location_assignment_uuid || !original.location_assignment_uri
            || !original.payload_json || !original.created_at) {
            throw new NonModelledAssetError("recovery_log_incomplete", 409,
                "the completed registration log lacks the identity, location, payload, or timestamp required for an auditable replay");
        }
        const originalCreatedAt = new Date(original.created_at);
        if (Number.isNaN(originalCreatedAt.valueOf())) {
            throw new NonModelledAssetError("recovery_log_incomplete", 409,
                "the canonical registration timestamp is invalid; recovery is refused");
        }

        let normalized: NormalizedRegistration;
        try {
            normalized = normalizeCommand({ ...JSON.parse(original.payload_json), registrationKey: original.idempotency_key });
        } catch (error) {
            if (error instanceof NonModelledAssetError) throw error;
            throw new NonModelledAssetError("recovery_log_incomplete", 409,
                "the canonical registration payload cannot be parsed for recovery");
        }
        if (registrationPayloadHash(normalized) !== original.payload_hash) {
            throw new NonModelledAssetError("recovery_payload_mismatch", 409,
                "the canonical registration payload no longer matches its persisted hash; recovery is refused");
        }
        if (normalized.initialSpaceId === null) {
            throw new NonModelledAssetError("recovery_log_incomplete", 409,
                "the original registration has no initial location; this recovery requires an unambiguous current location");
        }

        const ctx = getOperationalGraphContext();
        const recoveryKeyBase = `recover-registration:${original.operation_uuid}:${original.payload_hash}`;
        const recoveryHistory = (await nonModelledDb.listOperationsByAssetUuid(original.asset_uuid))
            .filter((row) => row.operation_type === "register_asset"
                && (row.idempotency_key === recoveryKeyBase || row.idempotency_key.startsWith(`${recoveryKeyBase}:attempt-`)));
        let recoveryAttempt = recoveryHistory.length + 1;
        let recovery = recoveryHistory.at(-1) ?? null;

        // Uma recuperação já concluída continua idempotente enquanto a
        // autoridade remota existir. Se ela voltar a desaparecer, não se
        // reabre nem se reescreve o evento anterior: cria-se uma tentativa
        // formal posterior, ligada ao mesmo comando original.
        if (recovery?.status === "completed") {
            const exists = await ctx.client.query(buildResourceExistsAsk(ctx.graphUri, original.asset_uri));
            if (exists.boolean === true) {
                return {
                    originalOperationUuid: original.operation_uuid,
                    recoveryOperationUuid: recovery.operation_uuid,
                    assetUuid: original.asset_uuid,
                    assetUri: original.asset_uri,
                    graphUri: ctx.graphUri,
                    graphWasRestored: false,
                };
            }
            recovery = null;
        } else if (recovery) {
            recoveryAttempt = recoveryHistory.length;
        }

        const recoveryKey = recoveryAttempt === 1 ? recoveryKeyBase : `${recoveryKeyBase}:attempt-${recoveryAttempt}`;
        const recoveryPayload = {
            recoveryKind: "replay_completed_registration",
            recoveryAttempt,
            originalOperationUuid: original.operation_uuid,
            originalIdempotencyKey: original.idempotency_key,
            originalPayloadHash: original.payload_hash,
            originalCreatedAt: originalCreatedAt.toISOString(),
        };
        const recoveryPayloadHash = canonicalPayloadHash(recoveryPayload);

        if (!recovery) {
            await nonModelledDb.createOperation({
                operationUuid: crypto.randomUUID(),
                idempotencyKey: recoveryKey,
                operationType: "register_asset",
                payloadHash: recoveryPayloadHash,
                payloadJson: JSON.stringify(recoveryPayload),
                assetUuid: original.asset_uuid,
                assetUri: original.asset_uri,
                locationAssignmentUuid: original.location_assignment_uuid,
                locationAssignmentUri: original.location_assignment_uri,
            });
            recovery = await nonModelledDb.findOperationByKey("register_asset", recoveryKey);
        }
        if (!recovery) throw new Error("recovery operation could not be read after creation");
        if (recovery.payload_hash !== recoveryPayloadHash) {
            throw new NonModelledAssetError("recovery_idempotency_conflict", 409,
                "the formal recovery key already belongs to a different recovery payload");
        }

        return nonModelledDb.withOperationLock(recovery.operation_uuid, async () => {
            const fresh = await nonModelledDb.findOperationByKey("register_asset", recoveryKey) ?? recovery!;
            if (fresh.status === "completed") {
                const exists = await ctx.client.query(buildResourceExistsAsk(ctx.graphUri, original.asset_uri!));
                if (exists.boolean !== true) {
                    throw new NonModelledAssetError("recovery_graph_lost", 503,
                        "the operational graph disappeared during an idempotent recovery check; rerun to append a new recovery attempt");
                }
                return {
                    originalOperationUuid: original.operation_uuid,
                    recoveryOperationUuid: fresh.operation_uuid,
                    assetUuid: original.asset_uuid!,
                    assetUri: original.asset_uri!,
                    graphUri: ctx.graphUri,
                    graphWasRestored: false,
                };
            }

            try {
                const space = await this.assertSpaceUsable(normalized.initialSpaceId!, "original initialSpaceId");
                const exists = await ctx.client.query(buildResourceExistsAsk(ctx.graphUri, original.asset_uri!));
                const graphWasRestored = exists.boolean !== true;
                if (graphWasRestored) {
                    await ctx.client.update(buildRegistrationInsert(ctx.vocab, ctx.graphUri, {
                        assetUri: original.asset_uri!,
                        assetUuid: original.asset_uuid!,
                        displayName: normalized.name,
                        assetType: normalized.assetType,
                        resourceKind: normalized.resourceKind,
                        managerCode: normalized.managerCode,
                        serialNumber: normalized.serialNumber,
                        registrationKey: original.idempotency_key,
                        sourceSystem: SOURCE_SYSTEM,
                        createdAtIso: originalCreatedAt.toISOString(),
                        activityUri: ctx.uris.provenanceActivityUri(original.operation_uuid),
                        assignment: {
                            assignmentUri: original.location_assignment_uri!,
                            spaceUri: ctx.uris.spaceUri(space.space_uuid),
                            validFromIso: originalCreatedAt.toISOString(),
                            source: "manual",
                        },
                    }));
                }
                await this.verifyRegistration(ctx, original, space);
                await nonModelledDb.setOperationStatus(fresh.operation_uuid, "graph_written", null);
                await nonModelledDb.setOperationStatus(fresh.operation_uuid, "completed", null);
                return {
                    originalOperationUuid: original.operation_uuid,
                    recoveryOperationUuid: fresh.operation_uuid,
                    assetUuid: original.asset_uuid!,
                    assetUri: original.asset_uri!,
                    graphUri: ctx.graphUri,
                    graphWasRestored,
                };
            } catch (error) {
                await nonModelledDb.setOperationStatus(fresh.operation_uuid, "failed_retryable", sanitizeSyncError(error));
                throw toHttpError(error);
            }
        });
    }

    async register(command: RegisterNonModelledAssetCommand): Promise<NonModelledAssetResult> {
        const normalized = normalizeCommand(command);
        const registrationKey = command.registrationKey.trim();
        const payloadHash = registrationPayloadHash(normalized);

        const existing = await nonModelledDb.findOperationByKey("register_asset", registrationKey);
        if (existing) {
            if (existing.payload_hash !== payloadHash) {
                throw new NonModelledAssetError(
                    "idempotency_conflict", 409,
                    "registrationKey was already used with a different payload — use a new key for a new command"
                );
            }
            if (existing.status === "failed_terminal") {
                throw new NonModelledAssetError(
                    "operation_failed_terminal", 409,
                    `Operation ${existing.operation_uuid} failed terminally (${existing.last_error_code ?? "unknown"}) — register with a new key after diagnosing`
                );
            }
            // mesma chave + mesmo payload: retoma/devolve a MESMA operação
            return this.resumeOperation(existing);
        }

        // duplicado do código do gestor (âmbito provisório documentado: ativos
        // não modelados, código normalizado por trim+uppercase)
        if (normalized.managerCode) {
            const duplicate = await nonModelledDb.findGraphAssetByManagerCode(normalized.managerCode.toUpperCase());
            if (duplicate) {
                throw new NonModelledAssetError(
                    "duplicate_manager_code", 409,
                    `managerCode '${normalized.managerCode}' is already used by non-modelled asset ${duplicate.id}`
                );
            }
        }

        if (normalized.initialSpaceId !== null) {
            await this.assertSpaceUsable(normalized.initialSpaceId, "initialSpaceId");
        }

        const ctx = getOperationalGraphContext();

        const assetUuid = crypto.randomUUID();
        const operationUuid = crypto.randomUUID();
        const assignmentUuid = normalized.initialSpaceId !== null ? crypto.randomUUID() : null;

        const assetUri = ctx.uris.assetUri(assetUuid);
        const assignmentUri = assignmentUuid ? ctx.uris.locationAssignmentUri(assignmentUuid) : null;

        try {
            await nonModelledDb.createOperation({
                operationUuid,
                idempotencyKey: registrationKey,
                operationType: "register_asset",
                payloadHash,
                payloadJson: JSON.stringify(normalized),
                assetUuid,
                assetUri,
                locationAssignmentUuid: assignmentUuid,
                locationAssignmentUri: assignmentUri,
            });
        } catch (error: any) {
            // (Prompt 6, §8.1) corrida na MESMA registrationKey: o UNIQUE
            // (operation_type, idempotency_key) fez o outro pedido vencer —
            // CONVERGIR para a operação dele em vez de devolver 500
            if (isDuplicateKeyError(error)) {
                logConcurrencyEvent("semantic_sync_concurrency", { operationType: "register_asset", detail: "idempotency_key_collision_converged" });
                const winner = await nonModelledDb.findOperationByKey("register_asset", registrationKey);
                if (winner) {
                    if (winner.payload_hash !== payloadHash) {
                        throw new NonModelledAssetError(
                            "idempotency_conflict", 409,
                            "registrationKey was already used with a different payload — use a new key for a new command"
                        );
                    }
                    return this.resumeOperation(winner);
                }
            }
            throw error;
        }

        // execução sob o lock da operação: um segundo pedido com a mesma chave
        // que convirja via resumeOperation espera aqui e, ao entrar, encontra
        // a operação 'completed' — devolve o resultado sem reexecutar nada
        const operation = await nonModelledDb.findOperationByKey("register_asset", registrationKey);
        return nonModelledDb.withOperationLock(operation!.operation_uuid, () =>
            this.executeRegistration(operation!, normalized, ctx));
    }

    /**
     * Retoma uma operação de registo existente (mesma chave ou retry explícito).
     * (Prompt 6, §8.4) Serializada por lock de operação: dois retries
     * simultâneos produzem NO MÁXIMO uma retomada efetiva — o segundo espera,
     * relê o estado e, se a operação entretanto concluiu, devolve o resultado
     * existente SEM incrementar attempt_count nem tocar no grafo/SQL.
     */
    async resumeOperation(operation: SyncOperationRow): Promise<NonModelledAssetResult> {
        if (operation.status === "completed") {
            // já concluída: devolve o resultado existente SEM nova tentativa
            return this.buildResult(operation);
        }

        return nonModelledDb.withOperationLock(operation.operation_uuid, async () => {
            // re-leitura DENTRO do lock: o estado pode ter mudado enquanto esperávamos
            const fresh = await nonModelledDb.findOperationByKey(operation.operation_type, operation.idempotency_key)
                ?? operation;
            if (fresh.status === "completed") {
                logConcurrencyEvent("semantic_sync_concurrency", { operationUuid: fresh.operation_uuid, detail: "resume_skipped_already_completed" });
                return this.buildResult(fresh);
            }

            // tentativa REAL de reexecução → incrementa o contador (ponto único;
            // a rota de retry e a reconciliação não incrementam por fora)
            await nonModelledDb.incrementOperationAttempt(fresh.operation_uuid);
            fresh.attempt_count += 1;

            const normalized: NormalizedRegistration = JSON.parse(fresh.payload_json ?? "{}");
            const ctx = getOperationalGraphContext();
            return this.executeRegistration(fresh, normalized, ctx);
        });
    }

    /* ------------------------------------------------------------------ */

    private async assertSpaceUsable(spaceId: number, field: string): Promise<any> {
        const space = await nonModelledDb.getSpaceById(spaceId);
        if (!space) {
            throw new NonModelledAssetError("space_not_found", 422, `${field} ${spaceId} does not exist`);
        }
        if (!space.space_uuid) {
            throw new NonModelledAssetError("space_not_persistent", 422, `${field} ${spaceId} has no persistent identity (space_uuid)`);
        }
        if (space.status !== "active") {
            throw new NonModelledAssetError("space_not_active", 422, `${field} ${spaceId} is '${space.status}' — only active spaces can receive assets`);
        }
        return space;
    }

    private async executeRegistration(
        operation: SyncOperationRow,
        normalized: NormalizedRegistration,
        ctx: OperationalGraphContext
    ): Promise<NonModelledAssetResult> {
        const assetUri = operation.asset_uri!;
        const assetUuid = operation.asset_uuid!;
        // atividade de proveniência determinística: deriva da própria operação,
        // para que um retry reutilize a MESMA URI
        const activityUri = ctx.uris.provenanceActivityUri(operation.operation_uuid);

        let space: any = null;
        if (normalized.initialSpaceId !== null) {
            space = await this.assertSpaceUsable(normalized.initialSpaceId, "initialSpaceId");
        }

        /* -------- fase 1: grafo (autoridade) -------- */
        if (operation.status === "pending_graph" || operation.status === "failed_retryable") {
            try {
                const exists = await ctx.client.query(buildResourceExistsAsk(ctx.graphUri, assetUri));
                if (exists.boolean !== true) {
                    const insert = buildRegistrationInsert(ctx.vocab, ctx.graphUri, {
                        assetUri,
                        assetUuid,
                        displayName: normalized.name,
                        assetType: normalized.assetType,
                        resourceKind: normalized.resourceKind,
                        managerCode: normalized.managerCode,
                        serialNumber: normalized.serialNumber,
                        registrationKey: operation.idempotency_key,
                        sourceSystem: SOURCE_SYSTEM,
                        createdAtIso: new Date().toISOString(),
                        activityUri,
                        assignment: space ? {
                            assignmentUri: operation.location_assignment_uri!,
                            spaceUri: ctx.uris.spaceUri(space.space_uuid),
                            validFromIso: new Date().toISOString(),
                            source: "manual",
                        } : null,
                    });
                    await ctx.client.update(insert);
                }

                await this.verifyRegistration(ctx, operation, space);
                await nonModelledDb.setOperationStatus(operation.operation_uuid, "graph_written", null);
                operation.status = "graph_written";
            } catch (error) {
                await nonModelledDb.setOperationStatus(operation.operation_uuid, "failed_retryable", sanitizeSyncError(error));
                throw toHttpError(error);
            }
        }

        /* -------- fase 2: política (provider configurado — nunca fixo) -------- */
        const decision = await getReservabilityEvaluator().evaluate({
            candidateKind: "non_modelled_asset",
            entityType: "element",
            name: normalized.name,
            assetType: normalized.assetType,
            resourceKind: normalized.resourceKind,
            source: "graph",
            isOperationalSource: true,
            managerCode: normalized.managerCode,
            serialNumber: normalized.serialNumber,
            hasCurrentLocation: space !== null,
            persistentIdentityStatus: "valid",
            lifecycleStatus: "active",
            operationalEvidenceStatus: "verified",
            semanticOperationStatus: "incomplete",
            sqlProjectionStatus: "unknown",
        }, { evaluationPhase: "registration" });
        logPolicyDecision("non_modelled_reservability", decision, { assetUuid });

        // allow ⇒ reservável; deny/undetermined/error ⇒ ativo preservado, NÃO reservável
        const reservable = decision.decision === "allow";

        /* -------- fase 3: projeção SQL (transacional, idempotente) -------- */
        if (operation.status === "graph_written" || operation.status === "pending_sql_projection") {
            try {
                await nonModelledDb.setOperationStatus(operation.operation_uuid, "pending_sql_projection", null);
                await nonModelledDb.projectRegistration({
                    assetUuid,
                    assetUri,
                    name: normalized.name,
                    resourceKind: normalized.resourceKind,
                    assetSubtype: normalized.assetType,
                    managerCode: normalized.managerCode,
                    serialNumber: normalized.serialNumber,
                    reservable,
                    assignment: space ? {
                        assignmentUuid: operation.location_assignment_uuid!,
                        assertionUri: operation.location_assignment_uri!,
                        spaceId: space.id,
                        source: "manual",
                        validFromIso: new Date().toISOString(),
                        provenanceActivityUri: activityUri,
                    } : null,
                });
                await nonModelledDb.setOperationStatus(operation.operation_uuid, "completed", null);
                operation.status = "completed";
            } catch (error: any) {
                // (Prompt 6, §8.2) corrida de managerCode com chaves DIFERENTES:
                // o UNIQUE funcional uq_assets_graph_manager_code fez o outro
                // registo vencer — retry nunca vai conseguir projetar, logo a
                // operação é TERMINAL com conflito claro (nunca 500 opaco).
                // O recurso já escrito no grafo fica para a reconciliação
                // reportar (decisão humana — nunca apagado automaticamente).
                if (isDuplicateKeyError(error) && /uq_assets_graph_manager_code/i.test(error?.message ?? "")) {
                    logConcurrencyEvent("semantic_sync_concurrency", { operationUuid: operation.operation_uuid, detail: "manager_code_unique_conflict" });
                    await nonModelledDb.setOperationStatus(operation.operation_uuid, "failed_terminal",
                        { code: "duplicate_manager_code", message: "managerCode already used by another non-modelled asset (database constraint)" });
                    throw new NonModelledAssetError(
                        "duplicate_manager_code", 409,
                        `managerCode '${normalized.managerCode}' is already used by another non-modelled asset — the concurrent registration won; the graph resource of this operation will surface in the reconciliation report`
                    );
                }
                // o grafo continua autoridade; a projeção fica pendente e o retry
                // reutiliza os mesmos UUIDs — o ativo NÃO fica reservável
                await nonModelledDb.setOperationStatus(operation.operation_uuid, "pending_sql_projection", sanitizeSyncError(error));
                throw toHttpError(error);
            }
        }

        return this.buildResult(operation, decision.decision);
    }

    /** Verificação pós-escrita: o grafo tem exatamente o que a operação diz. */
    private async verifyRegistration(ctx: OperationalGraphContext, operation: SyncOperationRow, space: any): Promise<void> {
        const result = await ctx.client.query(
            buildRegistrationVerificationSelect(ctx.vocab, ctx.graphUri, operation.asset_uri!));
        const bindings = result.results?.bindings ?? [];

        if (bindings.length === 0 || bindings[0]?.uuid?.value !== operation.asset_uuid) {
            throw new NonModelledAssetError(
                "graph_verification_failed", 502,
                "graph write verification failed: asset UUID not confirmed in the operational graph"
            );
        }
        if (space) {
            const expectedSpaceUri = ctx.uris.spaceUri(space.space_uuid);
            const current = bindings.filter((b: any) => b.assignment?.value);
            if (current.length !== 1 || current[0]?.space?.value !== expectedSpaceUri) {
                throw new NonModelledAssetError(
                    "graph_verification_failed", 502,
                    "graph write verification failed: initial location assignment not confirmed"
                );
            }
        }
    }

    private async buildResult(operation: SyncOperationRow, policyDecision?: string): Promise<NonModelledAssetResult> {
        const asset = await nonModelledDb.findAssetByUuid(operation.asset_uuid!);
        const current = asset ? await nonModelledDb.getCurrentAssignment(asset.id) : null;

        return {
            assetId: asset?.id ?? 0,
            assetUuid: operation.asset_uuid!,
            assetUri: operation.asset_uri!,
            name: asset?.name ?? "",
            assetType: asset?.asset_subtype ?? "",
            resourceKind: asset?.asset_type ?? "",
            managerCode: asset?.asset_code ?? null,
            serialNumber: asset?.serial_number ?? null,
            reservable: Boolean(asset?.reservable),
            policyDecision: policyDecision ?? (asset?.reservable ? "allow" : "not_allowed"),
            lifecycleStatus: asset?.lifecycle_status ?? "active",
            locationStatus: current ? "located" : "pending_location",
            currentLocation: current ? {
                assignmentUuid: current.assignment_uuid,
                spaceId: current.space_id,
                spaceUuid: current.space_uuid ?? null,
                spaceCode: current.space_code ?? null,
                validFrom: new Date(current.valid_from).toISOString(),
            } : null,
            operation: {
                id: operation.id ?? null,
                operationUuid: operation.operation_uuid,
                status: operation.status,
                attemptCount: operation.attempt_count,
            },
        };
    }
}

export default new NonModelledAssetRegistrationService();
