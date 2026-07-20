import MySQLDatabase from "./mysqlDatabase.ts";
import { logConcurrencyEvent } from "./concurrencyControl.ts";

/**
 * Operações sobre model_versions e a versão corrente (Prompt 2).
 *
 * Conceitos:
 *  - models é a linha lógica persistente; model_versions são as revisões;
 *  - a versão corrente é a apontada por models.current_version_id — nunca
 *    "o maior id";
 *  - estados: processing → active → archived; processing → failed.
 *    failed nunca pode tornar-se corrente; archived continua recuperável.
 */

export interface ReserveVersionInput {
    modelId: number;
    originalFilename: string;
    fileHash: string;
    fileSize: number;
    description?: string | null;
    createdBy?: string | null;
}

class ModelVersionDatabase {
    private db: MySQLDatabase;

    constructor() {
        this.db = new MySQLDatabase();
        this.db.connect();
    }

    /**
     * Reserva um número de versão de forma segura para concorrência:
     * transação DEDICADA + SELECT ... FOR UPDATE na linha de models serializa
     * uploads simultâneos do mesmo modelo (entre pedidos E entre processos —
     * Prompt 6: antes a conexão única anulava o FOR UPDATE intra-processo);
     * o UNIQUE(model_id, version_number) é a proteção de último recurso
     * (uma tentativa de retry em conflito).
     */
    async reserveVersion(input: ReserveVersionInput, retry = true): Promise<{ versionId: number; versionNumber: number }> {
        try {
            return await this.db.withTransaction(async (conn) => {
                const [modelRows]: any = await conn.execute(
                    "SELECT id FROM models WHERE id = :modelId FOR UPDATE",
                    { modelId: input.modelId }
                );

                if (!modelRows.length) {
                    throw new Error(`Model with id ${input.modelId} not found`);
                }

                const [maxRows]: any = await conn.execute(
                    "SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM model_versions WHERE model_id = :modelId",
                    { modelId: input.modelId }
                );

                const versionNumber = Number(maxRows[0].next);

                const [result]: any = await conn.execute(`
                    INSERT INTO model_versions
                        (model_id, version_number, status, original_filename, file_hash, file_size, description, created_by)
                    VALUES
                        (:modelId, :versionNumber, 'processing', :originalFilename, :fileHash, :fileSize, :description, :createdBy)
                `, {
                    modelId: input.modelId,
                    versionNumber,
                    originalFilename: input.originalFilename,
                    fileHash: input.fileHash,
                    fileSize: input.fileSize,
                    description: input.description ?? null,
                    createdBy: input.createdBy ?? null,
                });

                return { versionId: result.insertId, versionNumber };
            });
        } catch (error: any) {
            // Backstop de concorrência: colisão no UNIQUE(model_id, version_number)
            if (retry && /ER_DUP_ENTRY|Duplicate entry/i.test(error.code ?? error.message ?? "")) {
                logConcurrencyEvent("model_upload_concurrency", { modelId: input.modelId, detail: "version_number_collision_retry" });
                return this.reserveVersion(input, false);
            }
            throw error;
        }
    }

    async setStorageKey(versionId: number, storageKey: string): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(
            "UPDATE model_versions SET storage_key = :storageKey WHERE id = :versionId",
            { storageKey, versionId }
        );
    }

    /**
     * Ativa uma versão processada e troca a versão corrente numa única
     * transação: a nova versão passa a active, a anterior corrente passa a
     * archived e models.current_version_id passa a apontar para a nova.
     * Só uma versão em estado 'processing' pode ser ativada — uma versão
     * 'failed' nunca pode tornar-se corrente.
     */
    async activateVersion(modelId: number, versionId: number): Promise<void> {
        await this.db.withTransaction(async (conn) => {
            const [versionRows]: any = await conn.execute(
                "SELECT id, status FROM model_versions WHERE id = :versionId AND model_id = :modelId FOR UPDATE",
                { versionId, modelId }
            );

            if (!versionRows.length) {
                throw new Error(`Version ${versionId} not found for model ${modelId}`);
            }

            if (versionRows[0].status !== "processing") {
                throw new Error(`Only a version in 'processing' state can be activated (found '${versionRows[0].status}')`);
            }

            const [modelRows]: any = await conn.execute(
                "SELECT current_version_id FROM models WHERE id = :modelId FOR UPDATE",
                { modelId }
            );

            const previousCurrentId = modelRows[0]?.current_version_id ?? null;

            await conn.execute(
                "UPDATE model_versions SET status = 'active', activated_at = NOW() WHERE id = :versionId",
                { versionId }
            );

            if (previousCurrentId && previousCurrentId !== versionId) {
                await conn.execute(
                    "UPDATE model_versions SET status = 'archived' WHERE id = :previousId",
                    { previousId: previousCurrentId }
                );
            }

            await conn.execute(
                "UPDATE models SET current_version_id = :versionId WHERE id = :modelId",
                { versionId, modelId }
            );
        });
    }

    /** Marca uma versão como falhada (nunca toca na versão corrente). */
    async markFailed(versionId: number, reason: string): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`
            UPDATE model_versions
            SET status = 'failed',
                failure_reason = :reason,
                storage_key = NULL
            WHERE id = :versionId
        `, { reason: reason.slice(0, 5000), versionId });
    }

    async getVersionsByModel(modelId: number): Promise<any[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT v.id, v.model_id, v.version_number, v.status, v.storage_key,
                   v.original_filename, v.file_hash, v.file_size, v.description,
                   v.created_at, v.created_by, v.activated_at, v.failure_reason,
                   (v.id = m.current_version_id) AS is_current
            FROM model_versions v
            INNER JOIN models m ON m.id = v.model_id
            WHERE v.model_id = :modelId
            ORDER BY v.version_number ASC, v.id ASC
        `, { modelId });
        return rows;
    }

    async getVersionById(versionId: number): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT v.id, v.model_id, v.version_number, v.status, v.storage_key,
                   v.original_filename, v.file_hash, v.file_size, v.description,
                   v.created_at, v.created_by, v.activated_at, v.failure_reason,
                   (v.id = m.current_version_id) AS is_current
            FROM model_versions v
            INNER JOIN models m ON m.id = v.model_id
            WHERE v.id = :versionId
            LIMIT 1
        `, { versionId });
        return rows[0] ?? null;
    }

    /**
     * Versão corrente = models.current_version_id (referência explícita).
     * Nunca usa ORDER BY id DESC.
     */
    async getCurrentVersion(modelId: number): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT v.id, v.model_id, v.version_number, v.status, v.storage_key,
                   v.original_filename, v.file_hash, v.file_size, v.description,
                   v.created_at, v.created_by, v.activated_at, v.failure_reason,
                   TRUE AS is_current
            FROM models m
            INNER JOIN model_versions v ON v.id = m.current_version_id
            WHERE m.id = :modelId
            LIMIT 1
        `, { modelId });
        return rows[0] ?? null;
    }
}

export default new ModelVersionDatabase();
