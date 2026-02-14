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

    try {
      const guidToEntityId = new Map<string, number>();

      for (const spaceGuid in inventoryData) {
        const space = inventoryData[spaceGuid];

        /* -------------------------------------
              1️⃣ Criar ENTITY do tipo SPACE
        ------------------------------------- */
        const [spaceResult]: any = await this.db.connection.execute(`
          INSERT INTO entities (guid, name, ifc_type, entity_type, model_version_id)
          VALUES (:guid, :name, 'IfcSpace', 'space', :versionId)
        `, {
          guid: spaceGuid,
          name: space.spaceName,
          versionId
        });

        const spaceId = spaceResult.insertId;
        guidToEntityId.set(spaceGuid, spaceId);

        /* -------------------------------------
              2️⃣ Criar ASSET do tipo SPACE
        ------------------------------------- */
        await this.db.connection.execute(`
          INSERT INTO assets (name, asset_type, model_entity_id, current_space_entity_id)
          VALUES (:name, 'space', :entityId, NULL)
        `, {
          name: space.spaceName,
          entityId: spaceId
        });

        /* -------------------------------------
              3️⃣ Criar ELEMENTS dentro do SPACE
        ------------------------------------- */
        for (const element of space.elements) {

          const [elementResult]: any = await this.db.connection.execute(`
            INSERT INTO entities (guid, name, ifc_type, entity_type, model_version_id, parent_id)
            VALUES (:guid, :name, :ifcType, 'element', :versionId, :parentId)
          `, {
            guid: element.guid,
            name: element.name,
            ifcType: element.type,
            versionId,
            parentId: spaceId
          });

          const elementId = elementResult.insertId;
          guidToEntityId.set(element.guid, elementId);

          /* -------------------------------------
                4️⃣ Criar ASSET do tipo EQUIPMENT
                (Exceto sensores)
          ------------------------------------- */
          if (element.type !== 'IfcSensor') {
            await this.db.connection.execute(`
              INSERT INTO assets (name, asset_type, model_entity_id, current_space_entity_id)
              VALUES (:name, 'equipment', :entityId, :spaceId)
            `, {
              name: element.name,
              entityId: elementId,
              spaceId: spaceId
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
}

export default new InventoryDatabase();
