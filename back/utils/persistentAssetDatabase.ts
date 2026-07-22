import crypto from "crypto";
import MySQLDatabase from "./mysqlDatabase.ts";
import type { AssetIdentityLookup } from "../identity/assetIdentityTypes.ts";

export type StudentReservableAsset = {
    persistentAssetId: string;
    name: string;
    tag: string | null;
    location: { name: string | null; reference: string | null };
    representation: {
        kind: "modelled" | "non_modelled" | "undetermined";
        modelLineId?: number;
        modelName?: string;
        linkedModelId?: number;
    };
};

/**
 * Persistência da identidade dos ativos (Prompt 4):
 * assets persistentes, asset_bindings por versão, casos de reconciliação e
 * ciclo de vida. Identidade nunca depende de entity.id/versão/binding/nome/
 * localização/política; a versão corrente vem SEMPRE de models.current_version_id.
 */
class PersistentAssetDatabase implements AssetIdentityLookup {
    private db: MySQLDatabase;

    constructor() {
        this.db = new MySQLDatabase();
        this.db.connect();
    }

    /* ================= LOOKUPS DE IDENTIDADE ================= */

    /** Correspondência pela Tag institucional (asset_code = Tag EQP-). */
    async findEquipmentByTag(linkedModelId: number, tag: string): Promise<{ id: number; asset_code: string | null; serial_number: string | null }[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT id, asset_code, serial_number FROM assets
            WHERE linked_model_id = :linkedModelId
              AND asset_code = :tag
              AND asset_type = 'equipment'
              AND asset_uuid IS NOT NULL
        `, { linkedModelId, tag });
        return rows;
    }

    /** Evidência secundária: serial da instância física (campo separado). */
    async findEquipmentBySerial(linkedModelId: number, serial: string): Promise<{ id: number; asset_code: string | null; serial_number: string | null }[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT id, asset_code, serial_number FROM assets
            WHERE linked_model_id = :linkedModelId
              AND serial_number = :serial
              AND asset_type = 'equipment'
              AND asset_uuid IS NOT NULL
        `, { linkedModelId, serial });
        return rows;
    }

    async findSpaceAsset(spaceId: number): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(
            "SELECT * FROM assets WHERE space_id = :spaceId LIMIT 1", { spaceId });
        return rows[0] ?? null;
    }

    /** A linha de modelo já tem inventário persistente de ativos (fora desta versão)? */
    async modelHasPriorAssetBindings(modelId: number, excludeVersionId: number): Promise<boolean> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT ab.id FROM asset_bindings ab
            INNER JOIN model_versions v ON v.id = ab.model_version_id
            WHERE v.model_id = :modelId AND ab.model_version_id <> :excludeVersionId
            LIMIT 1
        `, { modelId, excludeVersionId });
        return rows.length > 0;
    }

    /* ================= ESCRITA ================= */

    async createAsset(input: {
        name: string;
        assetType: "space" | "equipment";
        /** Código institucional: Reference do espaço ou Tag EQP- do equipamento — nada mais. */
        assetCode?: string | null;
        /** Serial da instância física (evidência separada; NUNCA em asset_code). */
        serialNumber?: string | null;
        spaceId?: number | null;
        linkedModelId: number | null;
        reservable: boolean;
    }): Promise<{ assetId: number; assetUuid: string }> {
        await this.db.checkConnection();
        const assetUuid = crypto.randomUUID();

        const [result]: any = await this.db.connection.execute(`
            INSERT INTO assets
                (asset_uuid, name, asset_type, asset_code, serial_number, space_id, linked_model_id,
                 source, lifecycle_status, reservable, model_version_id)
            VALUES
                (:assetUuid, :name, :assetType, :assetCode, :serialNumber, :spaceId, :linkedModelId,
                 'ifc', 'active', :reservable, NULL)
        `, {
            assetUuid, name: input.name, assetType: input.assetType,
            assetCode: input.assetCode ?? null, serialNumber: input.serialNumber ?? null,
            spaceId: input.spaceId ?? null,
            linkedModelId: input.linkedModelId, reservable: input.reservable,
        });

        return { assetId: result.insertId, assetUuid };
    }

    /**
     * Enriquecimento de evidência: grava o serial APENAS quando o ativo ainda
     * não tem nenhum (um serial divergente é caso de reconciliação — nunca é
     * sobrescrito automaticamente).
     */
    async setAssetSerialIfMissing(assetId: number, serialNumber: string): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`
            UPDATE assets SET serial_number = :serialNumber
            WHERE id = :assetId AND serial_number IS NULL
        `, { serialNumber, assetId });
    }

    /** Projeção operacional (nome/reservabilidade) — nunca altera a identidade. */
    async updateAssetProjection(assetId: number, input: { name?: string | null; reservable?: boolean }): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`
            UPDATE assets
            SET name = COALESCE(:name, name),
                reservable = COALESCE(:reservable, reservable)
            WHERE id = :assetId
        `, { name: input.name ?? null, reservable: input.reservable ?? null, assetId });
    }

    async createBinding(input: {
        assetId: number;
        modelVersionId: number;
        modelEntityId: number;
        spaceId?: number | null;
        spaceEntityId?: number | null;
        ifcGuid: string;
        assetCodeSnapshot?: string | null;
        serialSnapshot?: string | null;
        nameSnapshot?: string | null;
        typeSnapshot?: string | null;
        /** ObjectType do proxy: classificação informativa — NUNCA identidade. */
        objectTypeSnapshot?: string | null;
        reconciliationMethod?: string | null;
        reconciliationConfidence?: string | null;
    }): Promise<number> {
        await this.db.checkConnection();
        const [result]: any = await this.db.connection.execute(`
            INSERT INTO asset_bindings
                (asset_id, model_version_id, model_entity_id, space_id, space_entity_id,
                 ifc_guid, asset_code_snapshot, serial_snapshot, name_snapshot, type_snapshot,
                 object_type_snapshot,
                 binding_status, reconciliation_status, reconciliation_method, reconciliation_confidence)
            VALUES
                (:assetId, :modelVersionId, :modelEntityId, :spaceId, :spaceEntityId,
                 :ifcGuid, :assetCodeSnapshot, :serialSnapshot, :nameSnapshot, :typeSnapshot,
                 :objectTypeSnapshot,
                 'active', 'resolved', :reconciliationMethod, :reconciliationConfidence)
        `, {
            assetId: input.assetId, modelVersionId: input.modelVersionId,
            modelEntityId: input.modelEntityId, spaceId: input.spaceId ?? null,
            spaceEntityId: input.spaceEntityId ?? null, ifcGuid: input.ifcGuid,
            assetCodeSnapshot: input.assetCodeSnapshot ?? null,
            serialSnapshot: input.serialSnapshot ?? null,
            nameSnapshot: input.nameSnapshot ?? null, typeSnapshot: input.typeSnapshot ?? null,
            objectTypeSnapshot: input.objectTypeSnapshot ?? null,
            reconciliationMethod: input.reconciliationMethod ?? null,
            reconciliationConfidence: input.reconciliationConfidence ?? null,
        });
        return result.insertId;
    }

    async createReconciliationCase(input: {
        modelVersionId: number;
        modelEntityId: number;
        ifcGuid: string;
        nameSnapshot?: string | null;
        typeSnapshot?: string | null;
        spaceId?: number | null;
        candidates: any[];
    }): Promise<number> {
        await this.db.checkConnection();
        const [result]: any = await this.db.connection.execute(`
            INSERT INTO asset_reconciliation_cases
                (model_version_id, model_entity_id, ifc_guid, name_snapshot, type_snapshot, space_id, candidates_json, status)
            VALUES
                (:modelVersionId, :modelEntityId, :ifcGuid, :nameSnapshot, :typeSnapshot, :spaceId, :candidatesJson, 'open')
        `, {
            modelVersionId: input.modelVersionId, modelEntityId: input.modelEntityId,
            ifcGuid: input.ifcGuid, nameSnapshot: input.nameSnapshot ?? null,
            typeSnapshot: input.typeSnapshot ?? null, spaceId: input.spaceId ?? null,
            candidatesJson: JSON.stringify(input.candidates ?? []),
        });
        return result.insertId;
    }

    /* ================= CICLO DE VIDA ================= */

    /**
     * Equipamentos da linha de modelo: presentes na versão corrente → active;
     * com histórico na linha mas ausentes da corrente → absent. Nunca apaga;
     * 'retired' nunca é inferido.
     */
    async reconcileEquipmentLifecycle(modelId: number, currentVersionId: number): Promise<void> {
        await this.db.checkConnection();

        await this.db.connection.execute(`
            UPDATE assets a
            SET a.lifecycle_status = 'absent'
            WHERE a.asset_type = 'equipment'
              AND a.asset_uuid IS NOT NULL
              AND a.lifecycle_status = 'active'
              AND EXISTS (
                SELECT 1 FROM asset_bindings ab
                INNER JOIN model_versions v ON v.id = ab.model_version_id
                WHERE ab.asset_id = a.id AND v.model_id = :modelId)
              AND NOT EXISTS (
                SELECT 1 FROM asset_bindings ab2
                WHERE ab2.asset_id = a.id AND ab2.model_version_id = :currentVersionId)
        `, { modelId, currentVersionId });

        await this.db.connection.execute(`
            UPDATE assets a
            SET a.lifecycle_status = 'active'
            WHERE a.asset_type = 'equipment'
              AND a.lifecycle_status = 'absent'
              AND EXISTS (
                SELECT 1 FROM asset_bindings ab
                WHERE ab.asset_id = a.id AND ab.model_version_id = :currentVersionId)
        `, { currentVersionId });
    }

    /** Ativos-espaço acompanham o estado do espaço persistente (space_id). */
    async reconcileSpaceAssetLifecycle(linkedModelId: number): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`
            UPDATE assets a
            INNER JOIN spaces s ON s.id = a.space_id
            SET a.lifecycle_status = CASE WHEN s.status = 'active' THEN 'active' ELSE 'absent' END
            WHERE s.linked_model_id = :linkedModelId
              AND a.lifecycle_status <> 'retired'
        `, { linkedModelId });
    }

    /* ================= COMPENSAÇÃO ================= */

    async deleteBindingsForVersion(versionId: number): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(
            "DELETE FROM asset_bindings WHERE model_version_id = :versionId", { versionId });
    }

    async deleteCasesForVersion(versionId: number): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(
            "DELETE FROM asset_reconciliation_cases WHERE model_version_id = :versionId", { versionId });
    }

    /**
     * Remove APENAS ativos criados exclusivamente pela operação falhada e sem
     * bindings de outras versões, sem reservas e sem casos resolvidos a apontar.
     */
    async deleteAssetsWithoutReferences(assetIds: number[]): Promise<void> {
        if (!assetIds.length) return;
        await this.db.checkConnection();
        for (const assetId of assetIds) {
            await this.db.connection.execute(`
                DELETE FROM assets
                WHERE id = :assetId
                  AND NOT EXISTS (SELECT 1 FROM asset_bindings ab WHERE ab.asset_id = :a2)
                  AND NOT EXISTS (SELECT 1 FROM res_reservations r WHERE r.asset_id = :a3)
                  AND NOT EXISTS (SELECT 1 FROM asset_reconciliation_cases c WHERE c.resolved_asset_id = :a4)
            `, { assetId, a2: assetId, a3: assetId, a4: assetId });
        }
    }

    /* ================= CONSULTA ================= */

    async getPersistentAsset(assetId: number): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(
            "SELECT * FROM assets WHERE id = :assetId LIMIT 1", { assetId });
        return rows[0] ?? null;
    }

    async getStudentAssetByCurrentBinding(modelLineId: number, ifcGuid: string): Promise<StudentReservableAsset | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT a.asset_uuid, a.name, a.asset_code,
                   m.id AS model_line_id, m.name AS model_line_name,
                   lm.id AS linked_model_id, 'modelled' AS representation_kind,
                   s.name AS location_name, s.inventory_code AS location_reference
            FROM models m
            INNER JOIN linked_models lm ON lm.id = m.linked_parent_id
            INNER JOIN asset_bindings ab ON ab.model_version_id = m.current_version_id
              AND ab.binding_status = 'active' AND ab.ifc_guid = :ifcGuid
            INNER JOIN assets a ON a.id = ab.asset_id
              AND a.asset_uuid IS NOT NULL AND a.lifecycle_status = 'active' AND a.reservable = 1
            LEFT JOIN spaces s ON s.id = ab.space_id
            WHERE m.id = :modelLineId
            ORDER BY ab.id ASC LIMIT 1
        `, { modelLineId, ifcGuid });
        return rows[0] ? this.toStudentAsset(rows[0]) : null;
    }

    async resolveReservableAssetId(persistentAssetId: string): Promise<number | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT id FROM assets
            WHERE asset_uuid = :persistentAssetId
              AND lifecycle_status = 'active' AND reservable = 1
            LIMIT 1
        `, { persistentAssetId });
        return rows[0] ? Number(rows[0].id) : null;
    }

    private toStudentAsset(row: any): StudentReservableAsset {
        const kind = row.representation_kind as StudentReservableAsset["representation"]["kind"];
        return {
            persistentAssetId: String(row.asset_uuid),
            name: String(row.name),
            tag: row.asset_code ?? null,
            location: { name: row.location_name ?? null, reference: row.location_reference ?? null },
            representation: kind === "modelled" ? {
                kind,
                modelLineId: Number(row.model_line_id),
                modelName: String(row.model_line_name),
                linkedModelId: Number(row.linked_model_id),
            } : { kind },
        };
    }

    async getBindingsByAsset(assetId: number): Promise<any[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT ab.*, v.version_number, v.status AS version_status, v.model_id
            FROM asset_bindings ab
            INNER JOIN model_versions v ON v.id = ab.model_version_id
            WHERE ab.asset_id = :assetId
            ORDER BY ab.model_version_id ASC
        `, { assetId });
        return rows;
    }

    async getBindingsByVersion(versionId: number): Promise<any[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT ab.*, a.asset_uuid, a.asset_code, a.lifecycle_status, a.reservable
            FROM asset_bindings ab
            INNER JOIN assets a ON a.id = ab.asset_id
            WHERE ab.model_version_id = :versionId
            ORDER BY ab.id ASC
        `, { versionId });
        return rows;
    }

    async listReconciliationCases(status?: string): Promise<any[]> {
        await this.db.checkConnection();
        const [rows]: any = status
            ? await this.db.connection.execute(
                "SELECT * FROM asset_reconciliation_cases WHERE status = :status ORDER BY id ASC", { status })
            : await this.db.connection.execute(
                "SELECT * FROM asset_reconciliation_cases ORDER BY id ASC");
        return rows;
    }

    async getReconciliationCase(caseId: number): Promise<any | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(
            "SELECT * FROM asset_reconciliation_cases WHERE id = :caseId LIMIT 1", { caseId });
        return rows[0] ?? null;
    }

    async markCaseResolved(caseId: number, status: string, resolvedAssetId: number | null, resolvedBy: string | null): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`
            UPDATE asset_reconciliation_cases
            SET status = :status, resolved_asset_id = :resolvedAssetId,
                resolved_by = :resolvedBy, resolved_at = NOW()
            WHERE id = :caseId AND status = 'open'
        `, { status, resolvedAssetId, resolvedBy, caseId });
    }

    /**
     * Resolução de um caso de reconciliação numa TRANSAÇÃO ÚNICA com lock na
     * linha do caso (Prompt 6, §7 — CONCURRENCY_AUDIT §4.3).
     *
     * Antes: a rota verificava status='open', criava asset/binding, retirava
     * o substituído e SÓ DEPOIS marcava o caso — duas resoluções simultâneas
     * passavam ambas a verificação e produziam dois assets/duas retiradas.
     *
     * Agora: SELECT ... FOR UPDATE na linha do caso; a segunda resolução
     * concorrente espera pelo lock, encontra o caso já resolvido e recebe um
     * conflito (a rota traduz para 409). Casos já resolvidos NUNCA são
     * alterados. Todas as escritas partilham a mesma transação — ou tudo, ou
     * nada (o backstop uq_ab_entity mantém-se como última defesa).
     *
     * `resolution.decision` vem avaliada de fora (o provider de política não
     * corre dentro da transação para não prolongar a posse do lock).
     */
    async resolveCaseTransactionally(input: {
        caseId: number;
        caseStatus: string;             // resolved_link | resolved_new | resolved_replacement | ignored
        resolvedBy: string | null;
        /** Para link_to_existing_asset: usa este asset; para confirm_*: null (cria). */
        linkAssetId: number | null;
        /** Para confirm_as_new_asset / confirm_replacement: dados do novo ativo. */
        newAsset: { name: string; reservable: boolean } | null;
        /** Para confirm_replacement: ativo substituído a retirar. */
        retireAssetId: number | null;
        /** Quando true (ignored), não cria binding. */
        skipBinding: boolean;
    }): Promise<{ resolvedAssetId: number | null; alreadyResolvedAs?: string }> {
        return this.db.withTransaction(async (conn) => {
            const [caseRows]: any = await conn.execute(
                "SELECT * FROM asset_reconciliation_cases WHERE id = :caseId LIMIT 1 FOR UPDATE",
                { caseId: input.caseId }
            );
            if (!caseRows.length) {
                throw new Error(`Case ${input.caseId} not found`);
            }
            const reconciliationCase = caseRows[0];
            if (reconciliationCase.status !== "open") {
                // resolução concorrente perdeu a corrida — devolve o estado
                // atual para a rota responder 409 sem repetir efeitos
                return { resolvedAssetId: reconciliationCase.resolved_asset_id ?? null, alreadyResolvedAs: reconciliationCase.status };
            }

            let resolvedAssetId: number | null = input.linkAssetId;

            if (input.newAsset) {
                const assetUuid = crypto.randomUUID();
                const [created]: any = await conn.execute(`
                    INSERT INTO assets
                        (asset_uuid, name, asset_type, asset_code, serial_number, space_id, linked_model_id,
                         source, lifecycle_status, reservable, model_version_id)
                    VALUES
                        (:assetUuid, :name, 'equipment', NULL, NULL, NULL, NULL,
                         'ifc', 'active', :reservable, NULL)
                `, { assetUuid, name: input.newAsset.name, reservable: input.newAsset.reservable });
                resolvedAssetId = created.insertId;
            }

            if (input.retireAssetId !== null) {
                // decisão HUMANA explícita: o ativo substituído é retirado
                await conn.execute(`
                    UPDATE assets SET lifecycle_status = 'retired', retired_at = NOW()
                    WHERE id = :assetId
                `, { assetId: input.retireAssetId });
            }

            if (resolvedAssetId !== null && !input.skipBinding) {
                await conn.execute(`
                    INSERT INTO asset_bindings
                        (asset_id, model_version_id, model_entity_id, space_id, space_entity_id,
                         ifc_guid, asset_code_snapshot, serial_snapshot, name_snapshot, type_snapshot,
                         object_type_snapshot,
                         binding_status, reconciliation_status, reconciliation_method, reconciliation_confidence)
                    VALUES
                        (:assetId, :modelVersionId, :modelEntityId, :spaceId, NULL,
                         :ifcGuid, NULL, NULL, :nameSnapshot, :typeSnapshot,
                         NULL,
                         'active', 'resolved', :reconciliationMethod, 'manual')
                `, {
                    assetId: resolvedAssetId,
                    modelVersionId: reconciliationCase.model_version_id,
                    modelEntityId: reconciliationCase.model_entity_id,
                    spaceId: reconciliationCase.space_id ?? null,
                    ifcGuid: reconciliationCase.ifc_guid,
                    nameSnapshot: reconciliationCase.name_snapshot ?? null,
                    typeSnapshot: reconciliationCase.type_snapshot ?? null,
                    reconciliationMethod: input.caseStatus,
                });
            }

            const [marked]: any = await conn.execute(`
                UPDATE asset_reconciliation_cases
                SET status = :status, resolved_asset_id = :resolvedAssetId,
                    resolved_by = :resolvedBy, resolved_at = NOW()
                WHERE id = :caseId AND status = 'open'
            `, {
                status: input.caseStatus,
                resolvedAssetId,
                resolvedBy: input.resolvedBy,
                caseId: input.caseId,
            });
            if (marked.affectedRows === 0) {
                // impossível sob o FOR UPDATE, mas nunca deixar passar em silêncio
                throw new Error(`Case ${input.caseId} could not be marked resolved (state changed concurrently)`);
            }

            return { resolvedAssetId };
        });
    }

    async retireAsset(assetId: number): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`
            UPDATE assets SET lifecycle_status = 'retired', retired_at = NOW()
            WHERE id = :assetId
        `, { assetId });
    }
}

export default new PersistentAssetDatabase();
