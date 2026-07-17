import crypto from "crypto";
import MySQLDatabase from "./mysqlDatabase.ts";

/**
 * Persistência da identidade dos espaços (spaces + space_bindings) — Prompt 3.
 *
 * Regras estruturais:
 *  - unicidade provisória por âmbito: UNIQUE(linked_model_id,
 *    inventory_code_normalized) — ADR-0005;
 *  - uma entity nunca liga a dois espaços (UNIQUE(entity_id));
 *  - um espaço tem no máximo um binding por versão (UNIQUE(space_id,
 *    model_version_id));
 *  - bindings históricos nunca são sobrescritos;
 *  - a versão é sempre explícita (nunca "o maior id").
 */
class SpaceDatabase {
    private db: MySQLDatabase;

    constructor() {
        this.db = new MySQLDatabase();
        this.db.connect();
    }

    async findByScopeAndCode(linkedModelId: number, normalizedCode: string): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT * FROM spaces
            WHERE linked_model_id = :linkedModelId
              AND inventory_code_normalized = :normalizedCode
            LIMIT 1
        `, { linkedModelId, normalizedCode });
        return rows[0] ?? null;
    }

    async createSpace(input: {
        linkedModelId: number;
        inventoryCode: string;
        inventoryCodeNormalized: string;
        name?: string | null;
    }): Promise<{ spaceId: number; spaceUuid: string }> {
        await this.db.checkConnection();

        const spaceUuid = crypto.randomUUID();

        const [result]: any = await this.db.connection.execute(`
            INSERT INTO spaces
                (space_uuid, inventory_code, inventory_code_normalized, linked_model_id, name, status)
            VALUES
                (:spaceUuid, :inventoryCode, :inventoryCodeNormalized, :linkedModelId, :name, 'active')
        `, {
            spaceUuid,
            inventoryCode: input.inventoryCode,
            inventoryCodeNormalized: input.inventoryCodeNormalized,
            linkedModelId: input.linkedModelId,
            name: input.name ?? null,
        });

        return { spaceId: result.insertId, spaceUuid };
    }

    async createBinding(input: {
        spaceId: number;
        modelVersionId: number;
        entityId: number;
        ifcGuid: string;
        inventoryCodeSnapshot: string;
        nameSnapshot?: string | null;
        longNameSnapshot?: string | null;
    }): Promise<number> {
        await this.db.checkConnection();

        const [result]: any = await this.db.connection.execute(`
            INSERT INTO space_bindings
                (space_id, model_version_id, entity_id, ifc_guid,
                 inventory_code_snapshot, name_snapshot, long_name_snapshot, binding_status)
            VALUES
                (:spaceId, :modelVersionId, :entityId, :ifcGuid,
                 :inventoryCodeSnapshot, :nameSnapshot, :longNameSnapshot, 'active')
        `, {
            spaceId: input.spaceId,
            modelVersionId: input.modelVersionId,
            entityId: input.entityId,
            ifcGuid: input.ifcGuid,
            inventoryCodeSnapshot: input.inventoryCodeSnapshot,
            nameSnapshot: input.nameSnapshot ?? null,
            longNameSnapshot: input.longNameSnapshot ?? null,
        });

        return result.insertId;
    }

    async hasBindingForEntity(entityId: number): Promise<boolean> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(
            "SELECT id FROM space_bindings WHERE entity_id = :entityId LIMIT 1", { entityId });
        return rows.length > 0;
    }

    /** Compensação de falha: remove os bindings da versão (antes de apagar entities). */
    async deleteBindingsForVersion(versionId: number): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(
            "DELETE FROM space_bindings WHERE model_version_id = :versionId", { versionId });
    }

    /**
     * Compensação de falha: remove APENAS espaços criados exclusivamente pela
     * operação falhada e sem nenhum outro binding. Espaços preexistentes nunca
     * são apagados.
     */
    async deleteSpacesWithoutBindings(spaceIds: number[]): Promise<void> {
        if (!spaceIds.length) return;
        await this.db.checkConnection();

        for (const spaceId of spaceIds) {
            await this.db.connection.execute(`
                DELETE FROM spaces
                WHERE id = :spaceId
                  AND NOT EXISTS (SELECT 1 FROM space_bindings sb WHERE sb.space_id = :spaceId2)
            `, { spaceId, spaceId2: spaceId });
        }
    }

    /**
     * Reconciliação de estado após ativação de uma versão do modelo espacial
     * AUTORITATIVO: espaços do âmbito cujo código não está na versão corrente
     * ficam 'absent'; os presentes voltam a 'active'. Nunca apaga nem retira
     * (retired é operação explícita futura); nunca toca em reservas/ativos.
     */
    async reconcileStatusesForLinkedModel(linkedModelId: number, presentNormalizedCodes: string[]): Promise<void> {
        await this.db.checkConnection();

        if (presentNormalizedCodes.length === 0) {
            await this.db.connection.execute(`
                UPDATE spaces SET status = 'absent'
                WHERE linked_model_id = :linkedModelId AND status = 'active'
            `, { linkedModelId });
            return;
        }

        const placeholders = presentNormalizedCodes.map((_, i) => `:code${i}`).join(", ");
        const params: any = { linkedModelId };
        presentNormalizedCodes.forEach((c, i) => { params[`code${i}`] = c; });

        await this.db.connection.execute(`
            UPDATE spaces SET status = 'absent'
            WHERE linked_model_id = :linkedModelId
              AND status = 'active'
              AND inventory_code_normalized NOT IN (${placeholders})
        `, params);

        await this.db.connection.execute(`
            UPDATE spaces SET status = 'active'
            WHERE linked_model_id = :linkedModelId
              AND status = 'absent'
              AND inventory_code_normalized IN (${placeholders})
        `, params);
    }

    async getSpacesByLinkedModel(linkedModelId: number): Promise<any[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT * FROM spaces
            WHERE linked_model_id = :linkedModelId
            ORDER BY inventory_code_normalized ASC
        `, { linkedModelId });
        return rows;
    }

    async getBindingsBySpace(spaceId: number): Promise<any[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT sb.*, v.version_number, v.status AS version_status, v.model_id
            FROM space_bindings sb
            INNER JOIN model_versions v ON v.id = sb.model_version_id
            WHERE sb.space_id = :spaceId
            ORDER BY sb.model_version_id ASC
        `, { spaceId });
        return rows;
    }

    async getBindingsByVersion(versionId: number): Promise<any[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT sb.*, s.space_uuid, s.inventory_code, s.status AS space_status
            FROM space_bindings sb
            INNER JOIN spaces s ON s.id = sb.space_id
            WHERE sb.model_version_id = :versionId
            ORDER BY sb.id ASC
        `, { versionId });
        return rows;
    }

    /**
     * Autoridade espacial da federação (ADR-0006): valor explícito de
     * linked_models.spatial_authority_model_id; por omissão, quando a federação
     * tem exatamente um model, esse model é a autoridade; com vários models e
     * sem configuração, NENHUMA autoridade é assumida (pendente de confirmação).
     */
    async resolveSpatialAuthority(linkedModelId: number): Promise<number | null> {
        await this.db.checkConnection();

        const [rows]: any = await this.db.connection.execute(`
            SELECT lm.spatial_authority_model_id, COUNT(m.id) AS model_count, MIN(m.id) AS single_model_id
            FROM linked_models lm
            LEFT JOIN models m ON m.linked_parent_id = lm.id
            WHERE lm.id = :linkedModelId
            GROUP BY lm.id, lm.spatial_authority_model_id
        `, { linkedModelId });

        if (!rows.length) return null;

        if (rows[0].spatial_authority_model_id) return rows[0].spatial_authority_model_id;
        if (Number(rows[0].model_count) === 1) return rows[0].single_model_id;

        return null;
    }
}

export default new SpaceDatabase();
