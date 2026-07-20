import MySQLDatabase from "./mysqlDatabase.ts";

class InventoryDatabase {
  private db: MySQLDatabase;

  constructor() {
    this.db = new MySQLDatabase();
    this.db.connect();
  }

  /* -------------------------------------
        SAVE INVENTORY SNAPSHOT
  ------------------------------------- */

  /**
   * Grava o snapshot de ENTITIES do inventário e devolve os mapas
   * guid→entity_id de espaços e elementos.
   *
   * (Prompt 4) A criação de ativos deixou de acontecer aqui — os ativos são
   * identidades persistentes geridas pelo assetInventoryService, depois da
   * resolução da identidade dos espaços.
   */
  async saveInventorySnapshot(versionId: number, inventoryData: any): Promise<{
    spaceEntityIdsByGuid: Record<string, number>;
    elementEntityIdsByGuid: Record<string, number>;
  }> {
    // Transação DEDICADA (Prompt 6): também corrige um defeito antigo — o
    // throw de "Inventory already exists" acontecia com a transação aberta
    // e sem rollback; withTransaction garante rollback em qualquer erro.
    return this.db.withTransaction(async (conn) => {
      const [existing]: any = await conn.execute(`
        SELECT COUNT(*) as count
        FROM entities
        WHERE model_version_id = :versionId
      `, { versionId });

      if (existing[0].count > 0) {
        throw new Error("Inventory already exists for this version");
      }

      const spaceEntityIdsByGuid: Record<string, number> = {};
      const elementEntityIdsByGuid: Record<string, number> = {};
      const insertedGuids = new Set<string>();

      console.log("Inventory size:", Object.keys(inventoryData).length);

      for (const spaceGuid in inventoryData) {

        const space = inventoryData[spaceGuid];

        /* ------------------- SPACE ENTITY ------------------- */

        const [spaceResult]: any = await conn.execute(`
          INSERT INTO entities (guid, name, ifc_type, entity_type, model_version_id)
          VALUES (:guid, :name, 'IfcSpace', 'space', :versionId)
        `, {
          guid: spaceGuid,
          name: space.spaceName,
          versionId
        });

        const spaceId = spaceResult.insertId;
        spaceEntityIdsByGuid[spaceGuid] = spaceId;

        /* ------------------- ELEMENTS ------------------- */

        for (const element of space.elements) {

          if (insertedGuids.has(element.guid)) {
            console.warn("[inventory] DUP GUID in payload", element.guid);
            continue;
          }

          insertedGuids.add(element.guid);

          const [elementResult]: any = await conn.execute(`
            INSERT INTO entities (
              guid,
              name,
              ifc_type,
              entity_type,
              model_version_id,
              parent_id
            )
            VALUES (
              :guid,
              :name,
              :ifcType,
              'element',
              :versionId,
              :parentId
            )
          `, {
            guid: element.guid,
            name: element.name,
            ifcType: element.type,
            versionId,
            parentId: spaceId
          });

          elementEntityIdsByGuid[element.guid] = elementResult.insertId;
        }
      }

      return { spaceEntityIdsByGuid, elementEntityIdsByGuid };
    });
  }


  /**
   * Compensação de falha do upload: apaga o inventário de uma versão que não
   * chegou a ser ativada, para não deixar entities/assets parciais utilizáveis.
   * A linha de model_versions é preservada (fica 'failed', para diagnóstico).
   * Ordem: assets → entities filhas (parent_id) → entities raiz, por causa
   * das FKs (assets→entities e entities.parent_id→entities).
   */
  async deleteInventoryForVersion(versionId: number) {
    await this.db.withTransaction(async (conn) => {
      await conn.execute(
        "DELETE FROM assets WHERE model_version_id = :versionId", { versionId });
      await conn.execute(
        "DELETE FROM entities WHERE model_version_id = :versionId AND parent_id IS NOT NULL", { versionId });
      await conn.execute(
        "DELETE FROM entities WHERE model_version_id = :versionId", { versionId });
    });
  }
}

export default new InventoryDatabase();
