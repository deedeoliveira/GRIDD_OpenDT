import MySQLDatabase from "./mysqlDatabase.ts";

class InventoryDatabase {
  private db: MySQLDatabase;

  constructor() {
    this.db = new MySQLDatabase();
    this.db.connect();
  }

  /* -------------------------------------
        MODEL VERSION
  ------------------------------------- */

  async createModelVersion(modelId: string, description?: string): Promise<number> {
    await this.db.checkConnection();

    const [result]: any = await this.db.connection.execute(
      `
      INSERT INTO model_versions (model_id, description)
      VALUES (:modelId, :description)
      `,
      {
        modelId,
        description: description ?? null
      }
    );

    if (!result || !result.insertId) {
      throw new Error("Failed to create model version");
    }

    return result.insertId;
  }

  /* -------------------------------------
        SAVE INVENTORY SNAPSHOT
  ------------------------------------- */

  async saveInventorySnapshot(versionId: number, inventoryData: any) {
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

    try {

      const insertedGuids = new Set<string>();

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

        /* ------------------- SPACE ASSET ------------------- */

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

          if (element.type !== 'IfcSensor') {
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
      return true;

    } catch (error) {
      await this.db.connection.rollback();
      throw error;
    }
  }


  async deleteModelVersion(versionId: number) {
    await this.db.checkConnection();

    await this.db.connection.execute(`
      DELETE FROM model_versions
      WHERE id = :versionId
    `, { versionId });
  }




}

export default new InventoryDatabase();
