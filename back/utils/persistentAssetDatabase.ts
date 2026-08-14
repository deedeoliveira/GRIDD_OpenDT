import crypto from "crypto";
import MySQLDatabase from "./mysqlDatabase.ts";
import type { AssetCurrentModelPresence, AssetIdentityLookup, AssetIdentityRow } from "../identity/assetIdentityTypes.ts";
import { canonicalEquipmentTagKey } from "../classification/equipmentTag.ts";

/**
 * TAG-1 §8 — tempo máximo de espera pelo lock de identidade por Tag canónica.
 * Excedê-lo levanta ConcurrencyError('lock_timeout') SEM retry: a operação falha
 * fechada (nunca prossegue sem proteção) e a compensação do upload trata o resto.
 */
const EQUIPMENT_TAG_IDENTITY_LOCK_TIMEOUT_SECONDS = 30;

/**
 * TAG-1 §8 — nome do lock consultivo da secção crítica de identidade de UMA Tag
 * canónica.
 *
 * Os nomes de `GET_LOCK` do MySQL são GLOBAIS AO SERVIDOR e limitados a 64
 * caracteres, e a Tag é texto livre do modelador (comprimento não limitado,
 * caracteres arbitrários). Por isso a Tag NUNCA entra em bruto no nome: entra o
 * seu SHA-256. O nome inclui também um hash da base de dados EXATA selecionada
 * (mesma razão que `spaceMetadataLockName`: senão o self-test descartável e
 * `digital_twin` disputariam o mesmo lock).
 *
 * Comprimento fixo: 15 + 12 + 1 + 24 = 52 caracteres (< 64), seja qual for a Tag.
 */
export function equipmentTagIdentityLockName(selectedDatabase: string, canonicalTag: string): string {
    const dbHash = crypto.createHash("sha256").update(selectedDatabase).digest("hex").slice(0, 12);
    const tagHash = crypto.createHash("sha256").update(canonicalTag).digest("hex").slice(0, 24);
    return `oswadt:eqp_tag:${dbHash}:${tagHash}`;
}

/**
 * Factory do nome do lock, resolvida NA conexão dedicada que vai segurar o
 * GET_LOCK (mesmo padrão de `spaceMetadataLockNameFactory`): garante que o
 * esquema que delimita o lock e a sessão que o detém são a MESMA conexão.
 */
export function equipmentTagIdentityLockNameFactory(canonicalTag: string): (conn: any) => Promise<string> {
    return async (conn: any) => {
        const [rows]: any = await conn.query("SELECT DATABASE() AS db");
        const selectedDatabase = rows?.[0]?.db;
        if (typeof selectedDatabase !== "string" || selectedDatabase.length === 0) {
            throw new Error("No database is selected on the current connection; the equipment-Tag identity lock cannot be scoped safely.");
        }
        return equipmentTagIdentityLockName(selectedDatabase, canonicalTag);
    };
}

export type StudentReservableAsset = {
    persistentAssetId: string;
    name: string;
    tag: string | null;
    /**
     * Location of the equipment asset, resolved through the persistent space matched by
     * GlobalId (ADR-0052): `inventoryCode` from IfcSpace.Name, `longName` from
     * IfcSpace.LongName, plus the internal space id/uuid. Never a "reference".
     */
    location: {
        spaceId: number | null;
        spaceUuid: string | null;
        inventoryCode: string | null;
        longName: string | null;
    };
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

    /**
     * TAG-1 §1/§2 — secção crítica de identidade de UMA Tag canónica, sob lock
     * NOMEADO do MySQL numa conexão dedicada (session-scoped no servidor), logo
     * cooperativa ENTRE PROCESSOS — nunca um mutex local ao processo.
     *
     * Tem de envolver a decisão INTEIRA de primeira aparição: releitura pela Tag
     * canónica, recolha de evidência (serial, histórico de GlobalId, presença em
     * modelo corrente) E a escrita create-se-ainda-ausente. Tags diferentes usam
     * nomes de lock diferentes e nunca bloqueiam umas às outras. Libertado no
     * `finally` de `withNamedLock`; em timeout falha FECHADA (sem prosseguir).
     *
     * Ordem de aquisição (sem ciclos): o lock de metadados de espaço por
     * linked_model, quando existe, é SEMPRE adquirido ANTES deste — nunca ao
     * contrário. O lock por linked_model NÃO substitui este: a identidade passou
     * a ser de portefólio e dois linked_models diferentes disputam a mesma Tag.
     */
    async withEquipmentTagIdentityLock<T>(canonicalTag: string, fn: () => Promise<T>): Promise<T> {
        await this.db.checkConnection();
        return this.db.withNamedLock(
            equipmentTagIdentityLockNameFactory(canonicalTag),
            EQUIPMENT_TAG_IDENTITY_LOCK_TIMEOUT_SECONDS,
            fn,
        );
    }

    /**
     * TAG-1 §2 (corrigido na V2) — correspondência pela Tag institucional em TODO
     * o portefólio. O predicado de identidade NÃO inclui `linked_model_id`.
     *
     * PORQUE NÃO HÁ PRÉ-FILTRO DE TAG NO SQL
     * --------------------------------------
     * A V1 fazia `WHERE UPPER(TRIM(asset_code)) = :canonicalTag` e voltava a
     * filtrar em JavaScript. Isso assumia — sem prova — que o `UPPER()` do MySQL é
     * um SUPERCONJUNTO do `.toUpperCase()` do JavaScript. Não é: as duas funções
     * não concordam em todo o Unicode (o JavaScript expande 'ß' → 'SS', o
     * `UPPER()` do MySQL não; o 'ı' sem ponto do turco e outros mapeamentos
     * sensíveis à locale também divergem). Bastava UMA Tag assim para que a
     * cláusula SQL excluísse uma linha que a função canónica considera a MESMA
     * identidade — um FALSO NEGATIVO de identidade, que criaria um segundo ativo
     * persistente para o mesmo equipamento. Confiar na collation da coluna
     * (utf8mb4_0900_ai_ci) tem o mesmo defeito: é uma equivalência DIFERENTE
     * (baseada em pesos UCA), não demonstravelmente um superconjunto desta regra
     * em todo o Unicode, e depende do ambiente/esquema em vez do código.
     *
     * A V2 elimina o risco em vez de o reduzir: o SQL devolve exatamente o DOMÍNIO
     * de linhas que a função canónica poderia alguma vez fazer corresponder
     * (equipamento persistente com `asset_code`), e a correspondência é decidida
     * SÓ por `canonicalEquipmentTagKey`, a única autoridade. Superconjunto por
     * construção — a prova não depende de nenhuma propriedade do motor.
     *
     * CUSTO, ASSUMIDO: é uma varredura da tabela `assets` restrita a equipamentos
     * (nenhum índice pode assistir, porque qualquer predicado indexável seria
     * precisamente a suposição que se rejeita). A TAG-1 prioriza deliberadamente a
     * correção sobre a otimização prematura; a solução indexada (coluna gerada
     * `canonical(asset_code)` + índice) exige migração, que NÃO está autorizada
     * nesta passagem e fica adiada para depois de uma auditoria real de Tags.
     */
    async findEquipmentByTag(canonicalTag: string): Promise<AssetIdentityRow[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT id, asset_code, serial_number, linked_model_id FROM assets
            WHERE asset_type = 'equipment'
              AND asset_uuid IS NOT NULL
              AND asset_code IS NOT NULL
            ORDER BY id ASC
        `, {});
        return (rows as AssetIdentityRow[]).filter(
            (row) => row.asset_code !== null && canonicalEquipmentTagKey(row.asset_code) === canonicalTag);
    }

    /**
     * TAG-1 §3 (corrigido na V2) — evidência secundária: serial da instância
     * física, DENTRO do mesmo `linked_model_id`.
     *
     * A V1 tinha removido o âmbito por completo, o que transformou o serial numa
     * restrição de identidade NEGATIVA de portefólio: um ativo sem qualquer
     * relação (outra Tag, outro modelo, sem histórico de GlobalId comum) passava a
     * poder vetar a criação limpa de uma Tag nova só por coincidência de serial.
     * Isso contradiz a regra congelada — o serial é evidência SECUNDÁRIA e não tem
     * unicidade de portefólio assumida.
     *
     * O âmbito por `linked_model_id` é o significado ORIGINAL desta heurística
     * ("o modelador mudou a Tag mas manteve o serial" acontece dentro da mesma
     * linha de modelo, entre versões) e não viola a TAG-1: o que a TAG-1 proíbe é
     * `linked_model_id` no predicado de IDENTIDADE pela Tag — não a sua presença
     * numa consulta de evidência secundária.
     */
    async findEquipmentBySerial(serial: string, linkedModelId: number): Promise<AssetIdentityRow[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT id, asset_code, serial_number, linked_model_id FROM assets
            WHERE serial_number = :serial
              AND linked_model_id = :linkedModelId
              AND asset_type = 'equipment'
              AND asset_uuid IS NOT NULL
            ORDER BY id ASC
        `, { serial, linkedModelId });
        return rows;
    }

    /**
     * TAG-1 §4 — ativos persistentes com binding (CORRENTE ou HISTÓRICO) para
     * este GlobalId. Um GlobalId identifica uma manifestação IFC, nunca a
     * identidade de portefólio: isto serve só para detetar que o mesmo GlobalId
     * reaparece agora com outra Tag canónica (evidência de conflito).
     */
    async findEquipmentByGuidHistory(ifcGuid: string): Promise<AssetIdentityRow[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT DISTINCT a.id, a.asset_code, a.serial_number, a.linked_model_id
            FROM asset_bindings ab
            INNER JOIN assets a ON a.id = ab.asset_id
            WHERE ab.ifc_guid = :ifcGuid
              AND a.asset_type = 'equipment'
              AND a.asset_uuid IS NOT NULL
            ORDER BY a.id ASC
        `, { ifcGuid });
        return rows;
    }

    /**
     * TAG-1 §7 — linhas de modelo em que este ativo está presente na versão
     * CORRENTE. "Corrente" é EXCLUSIVAMENTE `models.current_version_id` (a mesma
     * relação já usada por `getStudentAssetByCurrentBinding` e pela reconciliação
     * de ciclo de vida) — nunca timestamps, maior id ou ordem de upload.
     */
    async findCurrentModelPresence(assetId: number): Promise<AssetCurrentModelPresence[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT m.id AS model_id, m.current_version_id AS model_version_id
            FROM asset_bindings ab
            INNER JOIN models m ON m.current_version_id = ab.model_version_id
            WHERE ab.asset_id = :assetId
              AND ab.binding_status = 'active'
            ORDER BY m.id ASC
        `, { assetId });
        return rows;
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
        /** ADR-0052 §F: only real equipment/tools are assets; spaces never are. */
        assetType: "equipment" | "tool";
        /** Código institucional: Tag EQP- do equipamento — nada mais. */
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
                   s.id AS location_space_id, s.space_uuid AS location_space_uuid,
                   s.inventory_code AS location_inventory_code, s.long_name AS location_long_name
            FROM models m
            INNER JOIN linked_models lm ON lm.id = m.linked_parent_id
            INNER JOIN asset_bindings ab ON ab.model_version_id = m.current_version_id
              AND ab.binding_status = 'active' AND ab.ifc_guid = :ifcGuid
            INNER JOIN assets a ON a.id = ab.asset_id
              AND a.asset_uuid IS NOT NULL AND a.lifecycle_status = 'active' AND a.reservable = 1
              AND a.asset_type IN ('equipment', 'tool')
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
              AND asset_type IN ('equipment', 'tool')
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
            location: {
                spaceId: row.location_space_id != null ? Number(row.location_space_id) : null,
                spaceUuid: row.location_space_uuid ?? null,
                inventoryCode: row.location_inventory_code ?? null,
                longName: row.location_long_name ?? null,
            },
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
