/**
 * Projeção SQL dos ativos NÃO modelados e controlo de sincronização
 * (Prompt 5B; ADR-0026/0027).
 *
 * O grafo operacional é a AUTORIDADE destes ativos; estas tabelas são a
 * projeção operacional (reservas/listagens) e o workflow de sincronização.
 * Regras:
 *  - source='graph' identifica projeções; uma linha SQL NÃO prova existência
 *    semântica por si só;
 *  - histórico de localização nunca é sobrescrito (fechar = valid_to);
 *  - UMA atribuição corrente por ativo (UNIQUE em coluna gerada);
 *  - todas as escritas de projeção são idempotentes (retry reutiliza UUIDs);
 *  - nenhuma função aqui contacta o grafo — SQL puro.
 */
import MySQLDatabase from "./mysqlDatabase.ts";

export type SyncOperationType = "register_asset" | "move_asset";
export type SyncOperationStatus =
    | "pending_graph" | "graph_written" | "pending_sql_projection"
    | "completed" | "failed_retryable" | "failed_terminal";

export interface SyncOperationRow {
    id: number;
    operation_uuid: string;
    idempotency_key: string;
    operation_type: SyncOperationType;
    payload_hash: string;
    asset_uuid: string | null;
    asset_uri: string | null;
    location_assignment_uuid: string | null;
    location_assignment_uri: string | null;
    closed_assignment_uuid: string | null;
    payload_json: string | null;
    status: SyncOperationStatus;
    attempt_count: number;
    last_error_code: string | null;
    last_error_message: string | null;
    completed_at: string | null;
}

class NonModelledAssetDatabase {
    private db: MySQLDatabase;

    constructor() {
        this.db = new MySQLDatabase();
        this.db.connect();
    }

    /* ================= LOCKS DE CONCORRÊNCIA (Prompt 6; ADR-0031) =================
       Uma transação SQL não cobre a janela SQL→grafo→SQL das operações 5B —
       por isso a serialização usa locks NOMEADOS do MySQL (GET_LOCK) em
       conexões dedicadas do pool, válidos entre pedidos e entre processos.
       ORDEM GLOBAL: nm_asset → sync_op → (transação SQL). */

    /** Serializa movimentos (e retomas de movimento) do MESMO ativo. */
    async withAssetLock<T>(assetId: number, fn: () => Promise<T>): Promise<T> {
        return this.db.withNamedLock(`oswadt.nm_asset.${assetId}`, 10, fn);
    }

    /** Serializa retomadas da MESMA operação de sincronização. */
    async withOperationLock<T>(operationUuid: string, fn: () => Promise<T>): Promise<T> {
        return this.db.withNamedLock(`oswadt.sync_op.${operationUuid}`, 10, fn);
    }

    /** Serializa execuções de reconciliation apply-safe. */
    async withReconciliationLock<T>(fn: () => Promise<T>): Promise<T> {
        return this.db.withNamedLock("oswadt.reconciliation.apply", 30, fn);
    }

    /* ================= OPERAÇÕES DE SINCRONIZAÇÃO ================= */

    async findOperationByKey(operationType: SyncOperationType, idempotencyKey: string): Promise<SyncOperationRow | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT * FROM semantic_sync_operations
            WHERE operation_type = :operationType AND idempotency_key = :idempotencyKey
            LIMIT 1
        `, { operationType, idempotencyKey });
        return rows[0] ?? null;
    }

    async findOperationById(operationId: number): Promise<SyncOperationRow | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(
            "SELECT * FROM semantic_sync_operations WHERE id = :operationId LIMIT 1", { operationId });
        return rows[0] ?? null;
    }

    async createOperation(input: {
        operationUuid: string;
        idempotencyKey: string;
        operationType: SyncOperationType;
        payloadHash: string;
        payloadJson: string;
        assetUuid: string;
        assetUri: string;
        locationAssignmentUuid?: string | null;
        locationAssignmentUri?: string | null;
        closedAssignmentUuid?: string | null;
    }): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`
            INSERT INTO semantic_sync_operations
                (operation_uuid, idempotency_key, operation_type, payload_hash, payload_json,
                 asset_uuid, asset_uri, location_assignment_uuid, location_assignment_uri,
                 closed_assignment_uuid, status)
            VALUES
                (:operationUuid, :idempotencyKey, :operationType, :payloadHash, :payloadJson,
                 :assetUuid, :assetUri, :locationAssignmentUuid, :locationAssignmentUri,
                 :closedAssignmentUuid, 'pending_graph')
        `, {
            operationUuid: input.operationUuid,
            idempotencyKey: input.idempotencyKey,
            operationType: input.operationType,
            payloadHash: input.payloadHash,
            payloadJson: input.payloadJson,
            assetUuid: input.assetUuid,
            assetUri: input.assetUri,
            locationAssignmentUuid: input.locationAssignmentUuid ?? null,
            locationAssignmentUri: input.locationAssignmentUri ?? null,
            closedAssignmentUuid: input.closedAssignmentUuid ?? null,
        });
    }

    async setOperationStatus(
        operationUuid: string,
        status: SyncOperationStatus,
        error?: { code: string; message: string } | null
    ): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`
            UPDATE semantic_sync_operations
            SET status = :status,
                last_error_code = :errorCode,
                last_error_message = :errorMessage,
                completed_at = CASE WHEN :status = 'completed' THEN NOW() ELSE completed_at END
            WHERE operation_uuid = :operationUuid
        `, {
            status,
            errorCode: error?.code ?? null,
            errorMessage: error?.message?.slice(0, 1000) ?? null,
            operationUuid,
        });
    }

    async incrementOperationAttempt(operationUuid: string): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`
            UPDATE semantic_sync_operations
            SET attempt_count = attempt_count + 1
            WHERE operation_uuid = :operationUuid
        `, { operationUuid });
    }

    /** Operações incompletas de um ativo — bloqueiam novas reservas do próprio. */
    async countIncompleteOperationsForAsset(assetUuid: string): Promise<number> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT COUNT(*) AS n FROM semantic_sync_operations
            WHERE asset_uuid = :assetUuid
              AND status NOT IN ('completed', 'failed_terminal')
        `, { assetUuid });
        return Number(rows[0]?.n ?? 0);
    }

    async listIncompleteOperations(): Promise<SyncOperationRow[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT * FROM semantic_sync_operations
            WHERE status NOT IN ('completed', 'failed_terminal')
            ORDER BY id ASC
        `);
        return rows;
    }

    /* ================= PROJEÇÃO DO ATIVO ================= */

    async findAssetById(assetId: number): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(
            "SELECT * FROM assets WHERE id = :assetId LIMIT 1", { assetId });
        return rows[0] ?? null;
    }

    async findAssetByUuid(assetUuid: string): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(
            "SELECT * FROM assets WHERE asset_uuid = :assetUuid LIMIT 1", { assetUuid });
        return rows[0] ?? null;
    }

    /** Duplicado de código do gestor no âmbito provisório (source='graph', código normalizado). */
    async findGraphAssetByManagerCode(normalizedCode: string): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT * FROM assets
            WHERE source = 'graph' AND UPPER(TRIM(asset_code)) = :normalizedCode
            LIMIT 1
        `, { normalizedCode });
        return rows[0] ?? null;
    }

    async findSpaceByUuid(spaceUuid: string): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(
            "SELECT id, space_uuid, inventory_code, name, status FROM spaces WHERE space_uuid = :spaceUuid LIMIT 1", { spaceUuid });
        return rows[0] ?? null;
    }

    async getSpaceById(spaceId: number): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(
            "SELECT id, space_uuid, inventory_code, name, status FROM spaces WHERE id = :spaceId LIMIT 1", { spaceId });
        return rows[0] ?? null;
    }

    /**
     * Projeta (idempotentemente) o registo: INSERT do asset (source='graph')
     * e da atribuição inicial, em TRANSAÇÃO. Retry não duplica linhas.
     */
    async projectRegistration(input: {
        assetUuid: string;
        assetUri: string;
        name: string;
        resourceKind: "equipment" | "tool";
        assetSubtype: string;
        managerCode?: string | null;
        serialNumber?: string | null;
        reservable: boolean;
        assignment?: {
            assignmentUuid: string;
            assertionUri: string;
            spaceId: number;
            source: string;
            validFromIso: string;
            provenanceActivityUri?: string | null;
        } | null;
    }): Promise<{ assetId: number }> {
        return this.db.withTransaction(async (conn) => {
            let assetId: number;
            const [existingRows]: any = await conn.execute(
                "SELECT * FROM assets WHERE asset_uuid = :assetUuid LIMIT 1", { assetUuid: input.assetUuid });
            const existing = existingRows[0] ?? null;

            if (existing) {
                assetId = existing.id;
            } else {
                const [result]: any = await conn.execute(`
                    INSERT INTO assets
                        (asset_uuid, name, asset_type, asset_subtype, asset_code, serial_number,
                         semantic_uri, source, lifecycle_status, reservable,
                         model_version_id, linked_model_id, space_id)
                    VALUES
                        (:assetUuid, :name, :resourceKind, :assetSubtype, :managerCode, :serialNumber,
                         :semanticUri, 'graph', 'active', :reservable,
                         NULL, NULL, NULL)
                `, {
                    assetUuid: input.assetUuid,
                    name: input.name,
                    resourceKind: input.resourceKind,
                    assetSubtype: input.assetSubtype,
                    managerCode: input.managerCode ?? null,
                    serialNumber: input.serialNumber ?? null,
                    semanticUri: input.assetUri,
                    reservable: input.reservable,
                });
                assetId = result.insertId;
            }

            if (input.assignment) {
                await this.insertAssignmentIfMissing(conn, assetId, input.assignment);
            }

            return { assetId };
        });
    }

    private async insertAssignmentIfMissing(conn: any, assetId: number, assignment: {
        assignmentUuid: string;
        assertionUri: string;
        spaceId: number;
        source: string;
        validFromIso: string;
        provenanceActivityUri?: string | null;
    }): Promise<void> {
        const [existingRows]: any = await conn.execute(
            "SELECT id FROM asset_location_assignments WHERE assignment_uuid = :assignmentUuid LIMIT 1",
            { assignmentUuid: assignment.assignmentUuid });
        if (existingRows.length) return;

        await conn.execute(`
            INSERT INTO asset_location_assignments
                (assignment_uuid, semantic_assertion_uri, asset_id, space_id, source,
                 valid_from, provenance_activity_uri, projection_status)
            VALUES
                (:assignmentUuid, :assertionUri, :assetId, :spaceId, :source,
                 :validFrom, :provenanceActivityUri, 'projected')
        `, {
            assignmentUuid: assignment.assignmentUuid,
            assertionUri: assignment.assertionUri,
            assetId,
            spaceId: assignment.spaceId,
            source: assignment.source,
            validFrom: new Date(assignment.validFromIso),
            provenanceActivityUri: assignment.provenanceActivityUri ?? null,
        });
    }

    /**
     * Projeta (idempotentemente) um movimento: fecha a atribuição anterior
     * (valid_to) e insere a nova, em TRANSAÇÃO.
     */
    async projectMovement(input: {
        assetId: number;
        closedAssignmentUuid: string;
        closedAtIso: string;
        newAssignment: {
            assignmentUuid: string;
            assertionUri: string;
            spaceId: number;
            source: string;
            validFromIso: string;
            provenanceActivityUri?: string | null;
        };
    }): Promise<void> {
        await this.db.withTransaction(async (conn) => {
            // fecha a anterior APENAS se ainda estiver aberta (retry = no-op)
            await conn.execute(`
                UPDATE asset_location_assignments
                SET valid_to = :closedAt
                WHERE assignment_uuid = :closedAssignmentUuid AND valid_to IS NULL
            `, { closedAt: new Date(input.closedAtIso), closedAssignmentUuid: input.closedAssignmentUuid });

            await this.insertAssignmentIfMissing(conn, input.assetId, input.newAssignment);
        });
    }

    /**
     * Realinha o espaço de uma atribuição projetada com a autoridade (grafo).
     * Usado APENAS pela reconciliação segura, quando o grafo é inequívoco e a
     * projeção SQL da MESMA atribuição diverge.
     */
    async realignAssignmentSpace(assignmentUuid: string, spaceId: number): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`
            UPDATE asset_location_assignments
            SET space_id = :spaceId
            WHERE assignment_uuid = :assignmentUuid
        `, { spaceId, assignmentUuid });
    }

    /* ================= CONSULTAS ================= */

    async getCurrentAssignment(assetId: number): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT ala.*, s.space_uuid, s.inventory_code AS space_code, s.name AS space_name, s.status AS space_status
            FROM asset_location_assignments ala
            INNER JOIN spaces s ON s.id = ala.space_id
            WHERE ala.asset_id = :assetId AND ala.valid_to IS NULL
            LIMIT 1
        `, { assetId });
        return rows[0] ?? null;
    }

    async getLocationHistory(assetId: number): Promise<any[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT ala.*, s.space_uuid, s.inventory_code AS space_code, s.name AS space_name, s.status AS space_status
            FROM asset_location_assignments ala
            INNER JOIN spaces s ON s.id = ala.space_id
            WHERE ala.asset_id = :assetId
            ORDER BY ala.valid_from ASC, ala.id ASC
        `, { assetId });
        return rows;
    }

    async listGraphAssets(): Promise<any[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(
            "SELECT * FROM assets WHERE source = 'graph' ORDER BY id ASC");
        return rows;
    }

    async listCurrentAssignmentsForGraphAssets(): Promise<any[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT ala.*, a.asset_uuid, a.semantic_uri, s.space_uuid
            FROM asset_location_assignments ala
            INNER JOIN assets a ON a.id = ala.asset_id
            INNER JOIN spaces s ON s.id = ala.space_id
            WHERE a.source = 'graph' AND ala.valid_to IS NULL
        `);
        return rows;
    }

    /**
     * Combined read-only catalogue projection. Current model bindings and
     * graph-authoritative projections are classified in one query, with one
     * deterministic row per persistent asset.
     */
    async listStudentReservableAssets(modelLineId: number | null = null): Promise<any[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            WITH current_bindings AS (
                SELECT ab.asset_id, m.id AS model_line_id, m.name AS model_line_name,
                       lm.id AS linked_model_id, bs.name AS binding_space_name,
                       bs.inventory_code AS binding_space_reference,
                       ROW_NUMBER() OVER (PARTITION BY ab.asset_id ORDER BY m.id ASC, ab.id ASC) AS rn
                FROM asset_bindings ab
                INNER JOIN model_versions mv ON mv.id = ab.model_version_id
                INNER JOIN models m ON m.current_version_id = mv.id
                INNER JOIN linked_models lm ON lm.id = m.linked_parent_id
                LEFT JOIN spaces bs ON bs.id = ab.space_id
                WHERE ab.binding_status = 'active'
            )
            SELECT a.asset_uuid, a.name, a.asset_code,
                   cb.model_line_id, cb.model_line_name, cb.linked_model_id,
                   CASE WHEN cb.asset_id IS NOT NULL THEN 'modelled'
                        WHEN a.source = 'graph' AND a.semantic_uri IS NOT NULL THEN 'non_modelled'
                        ELSE 'undetermined' END AS representation_kind,
                   COALESCE(cb.binding_space_name, ls.name) AS location_name,
                   COALESCE(cb.binding_space_reference, ls.inventory_code) AS location_reference
            FROM assets a
            LEFT JOIN current_bindings cb ON cb.asset_id = a.id AND cb.rn = 1
            LEFT JOIN asset_location_assignments ala
                   ON ala.asset_id = a.id AND ala.valid_to IS NULL AND a.source = 'graph'
            LEFT JOIN spaces ls ON ls.id = ala.space_id
            WHERE a.asset_uuid IS NOT NULL
              AND a.lifecycle_status = 'active'
              AND a.reservable = 1
              AND (a.source <> 'graph' OR a.semantic_uri IS NOT NULL)
              AND (:modelLineId IS NULL OR cb.model_line_id = :modelLineId)
            ORDER BY representation_kind ASC, a.name ASC, a.asset_uuid ASC
        `, { modelLineId });
        return rows.map((row: any) => ({
            persistentAssetId: String(row.asset_uuid),
            name: String(row.name),
            tag: row.asset_code ?? null,
            location: { name: row.location_name ?? null, reference: row.location_reference ?? null },
            representation: row.representation_kind === "modelled" ? {
                kind: "modelled",
                modelLineId: Number(row.model_line_id),
                modelName: String(row.model_line_name),
                linkedModelId: Number(row.linked_model_id),
            } : { kind: row.representation_kind },
        }));
    }
}

export default new NonModelledAssetDatabase();
