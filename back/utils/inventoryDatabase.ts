import MySQLDatabase from "./mysqlDatabase.ts";
import { getReservabilityEvaluator } from "../policies/policyProvider.ts";

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
   * Grava o snapshot de inventário e devolve o mapa guid→entity_id dos
   * ESPAÇOS criados (usado pela identidade espacial do Prompt 3).
   */
  async saveInventorySnapshot(versionId: number, inventoryData: any): Promise<{ spaceEntityIdsByGuid: Record<string, number> }> {
    await this.db.checkConnection();
    await this.db.connection.beginTransaction();

    const [existing]: any = await this.db.connection.execute(`
      SELECT COUNT(*) as count
      FROM entities
      WHERE model_version_id = :versionId
    `, { versionId });

    if (existing[0].count > 0) {
      throw new Error("Inventory already exists for this version");
    }

    const spaceEntityIdsByGuid: Record<string, number> = {};

    try {

      const insertedGuids = new Set<string>();

      // A decisão de reservabilidade é delegada na política configurada
      // (default: legacy, que reproduz o comportamento da baseline).
      const reservability = getReservabilityEvaluator();

      console.log("Inventory size:", Object.keys(inventoryData).length);

      for (const spaceGuid in inventoryData) {

        const space = inventoryData[spaceGuid];

        /* ------------------- SPACE ENTITY ------------------- */

        const [spaceResult]: any = await this.db.connection.execute(`
          INSERT INTO entities (guid, name, ifc_type, entity_type, model_version_id)
          VALUES (:guid, :name, 'IfcSpace', 'space', :versionId)
        `, {
          guid: spaceGuid,
          name: space.spaceName,
          versionId
        });

        const spaceId = spaceResult.insertId;
        spaceEntityIdsByGuid[spaceGuid] = spaceId;

        /* ------------------- SPACE ASSET ------------------- */

        const spaceDecision = await reservability.evaluate({
          guid: spaceGuid,
          name: space.spaceName,
          ifcType: "IfcSpace",
          entityType: "space"
        }, { modelVersionId: versionId });

        if (spaceDecision.decision === "allow") {
          await this.db.connection.execute(`
            INSERT INTO assets (
              name,
              asset_type,
              model_entity_id,
              current_space_entity_id,
              model_version_id,
              reservable
            )
            VALUES (
              :name,
              'space',
              :entityId,
              NULL,
              :versionId,
              true
            )
          `, {
            name: space.spaceName,
            entityId: spaceId,
            versionId
          });
        }

        /* ------------------- ELEMENTS ------------------- */

        for (const element of space.elements) {

          if (insertedGuids.has(element.guid)) {
            console.warn("[inventory] DUP GUID in payload", element.guid);
            continue;
          }

          insertedGuids.add(element.guid);

          const [elementResult]: any = await this.db.connection.execute(`
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

          const elementId = elementResult.insertId;

          const elementDecision = await reservability.evaluate({
            guid: element.guid,
            name: element.name,
            ifcType: element.type,
            entityType: "element"
          }, { modelVersionId: versionId });

          if (elementDecision.decision === "allow") {
            await this.db.connection.execute(`
              INSERT INTO assets (
                name,
                asset_type,
                model_entity_id,
                current_space_entity_id,
                model_version_id,
                reservable
              )
              VALUES (
                :name,
                'equipment',
                :entityId,
                :spaceId,
                :versionId,
                true
              )
            `, {
              name: element.name,
              entityId: elementId,
              spaceId: spaceId,
              versionId
            });
          }
        }
      }

      await this.db.connection.commit();
      return { spaceEntityIdsByGuid };

    } catch (error) {
      await this.db.connection.rollback();
      throw error;
    }
  }


  /**
   * Compensação de falha do upload: apaga o inventário de uma versão que não
   * chegou a ser ativada, para não deixar entities/assets parciais utilizáveis.
   * A linha de model_versions é preservada (fica 'failed', para diagnóstico).
   * Ordem: assets → entities filhas (parent_id) → entities raiz, por causa
   * das FKs (assets→entities e entities.parent_id→entities).
   */
  async deleteInventoryForVersion(versionId: number) {
    await this.db.checkConnection();
    await this.db.connection.beginTransaction();

    try {
      await this.db.connection.execute(
        "DELETE FROM assets WHERE model_version_id = :versionId", { versionId });
      await this.db.connection.execute(
        "DELETE FROM entities WHERE model_version_id = :versionId AND parent_id IS NOT NULL", { versionId });
      await this.db.connection.execute(
        "DELETE FROM entities WHERE model_version_id = :versionId", { versionId });

      await this.db.connection.commit();
    } catch (error) {
      await this.db.connection.rollback();
      throw error;
    }
  }
}

export default new InventoryDatabase();
