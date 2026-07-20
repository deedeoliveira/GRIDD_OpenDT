/**
 * Estado SQL simulado para os fluxos de ativos não modelados (Prompt 5B).
 *
 * Implementa, sobre o fakeDb, as queries emitidas por
 * nonModelledAssetDatabase.ts e pelo gating de reservas — com estado em
 * memória (ops, assets, atribuições, espaços) para que os testes exercitem
 * os fluxos completos (registo, movimento, retry, reconciliação) sem BD real.
 */

export interface FakeSqlState {
    ops: any[];
    assets: any[];
    assignments: any[];
    spaces: any[];
    reservations: any[];
    nextId: number;
    /** Regex de SQL que deve falhar UMA vez (injeção de falha SQL). */
    failOnce: RegExp | null;
    handler: (sql: string, params?: any) => any;
}

export function createNonModelledSqlState(spaces: any[] = []): FakeSqlState {
    const state: FakeSqlState = {
        ops: [], assets: [], assignments: [], reservations: [],
        spaces: spaces.map((s) => ({ status: "active", ...s })),
        nextId: 1,
        failOnce: null,
        handler: () => [[]],
    };

    const joinSpace = (row: any) => {
        const space = state.spaces.find((s) => s.id === row.space_id) ?? {};
        return {
            ...row,
            space_uuid: space.space_uuid ?? null,
            space_code: space.inventory_code ?? null,
            space_name: space.name ?? null,
            space_status: space.status ?? null,
        };
    };

    state.handler = (sql: string, params?: any) => {
        if (state.failOnce && state.failOnce.test(sql)) {
            state.failOnce = null;
            throw new Error("fake SQL failure (injected)");
        }

        /* ---------------- semantic_sync_operations ---------------- */
        if (/INSERT INTO semantic_sync_operations/.test(sql)) {
            // emula UNIQUE(operation_type, idempotency_key) — Prompt 6 §8.1
            if (state.ops.some((o) => o.operation_type === params.operationType
                && o.idempotency_key === params.idempotencyKey)) {
                const err: any = new Error(`Duplicate entry '${params.idempotencyKey}' for key 'uq_sso_idempotency'`);
                err.errno = 1062; err.code = "ER_DUP_ENTRY";
                throw err;
            }
            const id = state.nextId++;
            state.ops.push({
                id,
                operation_uuid: params.operationUuid,
                idempotency_key: params.idempotencyKey,
                operation_type: params.operationType,
                payload_hash: params.payloadHash,
                payload_json: params.payloadJson,
                asset_uuid: params.assetUuid,
                asset_uri: params.assetUri,
                location_assignment_uuid: params.locationAssignmentUuid,
                location_assignment_uri: params.locationAssignmentUri,
                closed_assignment_uuid: params.closedAssignmentUuid,
                status: "pending_graph",
                attempt_count: 1,
                last_error_code: null,
                last_error_message: null,
                completed_at: null,
            });
            return [{ insertId: id }];
        }
        if (/FROM semantic_sync_operations\s+WHERE operation_type/.test(sql)) {
            // cópias, como o mysql2: o serviço mantém a sua vista local e a
            // "BD" só muda via UPDATEs (senão attempt_count contaria a dobrar)
            return [state.ops
                .filter((o) => o.operation_type === params.operationType && o.idempotency_key === params.idempotencyKey)
                .map((o) => ({ ...o }))];
        }
        if (/FROM semantic_sync_operations WHERE id =/.test(sql)) {
            return [state.ops.filter((o) => o.id === params.operationId).map((o) => ({ ...o }))];
        }
        if (/UPDATE semantic_sync_operations\s+SET status/.test(sql)) {
            const op = state.ops.find((o) => o.operation_uuid === params.operationUuid);
            if (op) {
                op.status = params.status;
                op.last_error_code = params.errorCode;
                op.last_error_message = params.errorMessage;
                if (params.status === "completed") op.completed_at = new Date();
            }
            return [{ affectedRows: op ? 1 : 0 }];
        }
        if (/SET attempt_count = attempt_count \+ 1/.test(sql)) {
            const op = state.ops.find((o) => o.operation_uuid === params.operationUuid);
            if (op) op.attempt_count += 1;
            return [{ affectedRows: op ? 1 : 0 }];
        }
        if (/SELECT COUNT\(\*\) AS n\s+FROM semantic_sync_operations/.test(sql)) {
            const n = state.ops.filter((o) =>
                o.asset_uuid === params.assetUuid && !["completed", "failed_terminal"].includes(o.status)).length;
            return [[{ n }]];
        }
        if (/FROM semantic_sync_operations\s+WHERE status NOT IN/.test(sql)) {
            return [state.ops
                .filter((o) => !["completed", "failed_terminal"].includes(o.status))
                .map((o) => ({ ...o }))];
        }

        /* ---------------- assets ---------------- */
        if (/INSERT INTO assets/.test(sql)) {
            // emula o UNIQUE funcional uq_assets_graph_manager_code — Prompt 6 §8.2
            const normalized = params.managerCode ? String(params.managerCode).trim().toUpperCase() : null;
            if (normalized && state.assets.some((a) => a.source === "graph" && a.asset_code
                && String(a.asset_code).trim().toUpperCase() === normalized)) {
                const err: any = new Error(`Duplicate entry '${normalized}' for key 'uq_assets_graph_manager_code'`);
                err.errno = 1062; err.code = "ER_DUP_ENTRY";
                throw err;
            }
            const id = state.nextId++;
            state.assets.push({
                id,
                asset_uuid: params.assetUuid,
                name: params.name,
                asset_type: params.resourceKind,
                asset_subtype: params.assetSubtype,
                asset_code: params.managerCode,
                serial_number: params.serialNumber,
                semantic_uri: params.semanticUri,
                source: "graph",
                lifecycle_status: "active",
                reservable: params.reservable ? 1 : 0,
                model_entity_id: null,
                model_version_id: null,
                space_id: null,
                linked_model_id: null,
            });
            return [{ insertId: id }];
        }
        if (/FROM assets WHERE asset_uuid/.test(sql)) {
            return [state.assets.filter((a) => a.asset_uuid === params.assetUuid)];
        }
        if (/FROM assets WHERE id =/.test(sql)) {
            return [state.assets.filter((a) => a.id === params.assetId)];
        }
        if (/UPPER\(TRIM\(asset_code\)\)/.test(sql)) {
            return [state.assets.filter((a) =>
                a.source === "graph" && a.asset_code
                && String(a.asset_code).trim().toUpperCase() === params.normalizedCode)];
        }
        if (/FROM assets WHERE source = 'graph'/.test(sql)) {
            return [state.assets.filter((a) => a.source === "graph")];
        }
        if (/SELECT lifecycle_status, source, reservable, asset_uuid FROM assets/.test(sql)) {
            return [state.assets.filter((a) => a.id === params.assetId)];
        }

        /* ---------------- spaces ---------------- */
        if (/FROM spaces WHERE id =/.test(sql)) {
            return [state.spaces.filter((s) => s.id === params.spaceId)];
        }
        if (/FROM spaces WHERE space_uuid/.test(sql)) {
            return [state.spaces.filter((s) => s.space_uuid === params.spaceUuid)];
        }

        /* -------- gating de reservas (reservationDatabase, Prompt 5B) --------
           tem de ser avaliado ANTES dos padrões genéricos de atribuições */
        if (/SELECT ala\.id\s+FROM asset_location_assignments ala/.test(sql)) {
            return [state.assignments
                .filter((a) => a.asset_id === params.assetId && a.valid_to === null)
                .map(joinSpace)
                .filter((row) => row.space_status === "active")
                .map((row) => ({ id: row.id }))];
        }

        /* ---------------- asset_location_assignments ---------------- */
        if (/SELECT id FROM asset_location_assignments WHERE assignment_uuid/.test(sql)) {
            return [state.assignments.filter((a) => a.assignment_uuid === params.assignmentUuid)];
        }
        if (/INSERT INTO asset_location_assignments/.test(sql)) {
            const id = state.nextId++;
            state.assignments.push({
                id,
                assignment_uuid: params.assignmentUuid,
                semantic_assertion_uri: params.assertionUri,
                asset_id: params.assetId,
                space_id: params.spaceId,
                source: params.source,
                valid_from: params.validFrom,
                valid_to: null,
                observed_at: null,
                confidence: null,
                provenance_activity_uri: params.provenanceActivityUri,
                projection_status: "projected",
            });
            return [{ insertId: id }];
        }
        if (/UPDATE asset_location_assignments\s+SET space_id/.test(sql)) {
            const row = state.assignments.find((a) => a.assignment_uuid === params.assignmentUuid);
            if (row) row.space_id = params.spaceId;
            return [{ affectedRows: row ? 1 : 0 }];
        }
        if (/UPDATE asset_location_assignments\s+SET valid_to/.test(sql)) {
            const row = state.assignments.find((a) =>
                a.assignment_uuid === params.closedAssignmentUuid && a.valid_to === null);
            if (row) row.valid_to = params.closedAt;
            return [{ affectedRows: row ? 1 : 0 }];
        }
        if (/FROM asset_location_assignments ala\s+INNER JOIN assets a ON/.test(sql)) {
            return [state.assignments
                .filter((row) => row.valid_to === null)
                .map((row) => {
                    const asset = state.assets.find((a) => a.id === row.asset_id) ?? {};
                    return joinSpace({ ...row, asset_uuid: asset.asset_uuid ?? null, semantic_uri: asset.semantic_uri ?? null });
                })
                .filter((row) => {
                    const asset = state.assets.find((a) => a.id === row.asset_id);
                    return asset?.source === "graph";
                })];
        }
        if (/FROM asset_location_assignments ala\s+INNER JOIN spaces s ON s\.id = ala\.space_id\s+WHERE ala\.asset_id .*valid_to IS NULL/s.test(sql)) {
            return [state.assignments
                .filter((a) => a.asset_id === params.assetId && a.valid_to === null)
                .map(joinSpace)];
        }
        if (/FROM asset_location_assignments ala\s+INNER JOIN spaces s ON s\.id = ala\.space_id\s+WHERE ala\.asset_id/.test(sql)) {
            return [state.assignments
                .filter((a) => a.asset_id === params.assetId)
                .map(joinSpace)];
        }

        /* ---------------- res_reservations (gating 5B em reservas reais) ---------------- */
        if (/FROM res_reservations\s+WHERE asset_id = :assetId\s+AND status IN \('approved'/.test(sql)) {
            const count = state.reservations.filter((r) =>
                r.asset_id === params.assetId
                && ["approved", "in_use", "no_show"].includes(r.status)
                && r.start_time < params.end && r.end_time > params.start).length;
            return [[{ count }]];
        }
        if (/FROM res_reservations\s+WHERE asset_id = :assetId\s+AND actor_id = :actorId/.test(sql)) {
            const count = state.reservations.filter((r) =>
                r.asset_id === params.assetId && r.actor_id === params.actorId
                && ["pending", "approved"].includes(r.status)
                && r.start_time < params.end && r.end_time > params.start).length;
            return [[{ count }]];
        }
        if (/INSERT INTO res_reservations/.test(sql)) {
            const id = state.nextId++;
            state.reservations.push({
                id, asset_id: params.assetId, actor_id: params.actorId,
                start_time: params.start, end_time: params.end, status: "pending",
                asset_binding_id_at_booking: params.bindingId,
                model_version_id_at_booking: params.versionId,
                asset_name_snapshot: params.assetName,
                space_id_at_booking: params.spaceId,
                space_code_snapshot: params.spaceCode,
            });
            return [{ insertId: id }];
        }
        if (/UPDATE res_reservations/.test(sql)) {
            return [{ affectedRows: 0 }];
        }
        if (/FROM asset_bindings ab/.test(sql)) {
            return [[]]; // ativos não modelados não têm bindings
        }
        if (/SELECT a\.name AS asset_name, ala\.space_id/.test(sql)) {
            const asset = state.assets.find((a) => a.id === params.assetId);
            if (!asset) return [[]];
            const current = state.assignments.find((a) => a.asset_id === asset.id && a.valid_to === null);
            const space = current ? state.spaces.find((s) => s.id === current.space_id) : null;
            return [[{
                asset_name: asset.name,
                space_id: current?.space_id ?? null,
                space_code: space?.inventory_code ?? null,
            }]];
        }

        return [[]];
    };

    return state;
}
