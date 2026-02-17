import MySQLDatabase from "./mysqlDatabase.ts";

class AssetDatabase {
  private db: MySQLDatabase;

  constructor() {
    this.db = new MySQLDatabase();
    this.db.connect();
  }

  async getAssetsBySpace(spaceEntityId: number, versionId: number) {
    await this.db.checkConnection();

    const [rows]: any = await this.db.connection.execute(`
      SELECT *
      FROM assets
      WHERE current_space_entity_id = :spaceEntityId
      AND model_version_id = :versionId
    `, { spaceEntityId, versionId });

    return rows;
  }

  async getAssetById(assetId: number, versionId: number) {
    await this.db.checkConnection();

    const [rows]: any = await this.db.connection.execute(`
      SELECT *
      FROM assets
      WHERE id = :assetId
      AND model_version_id = :versionId
      LIMIT 1
    `, { assetId, versionId });

    return rows[0] || null;
  }

  async getAssetsByModel(modelId: number, versionId: number) {
    await this.db.checkConnection();

    const [rows]: any = await this.db.connection.execute(`
        SELECT a.*
        FROM assets a
        INNER JOIN model_versions mv
        ON a.model_version_id = mv.id
        WHERE mv.model_id = :modelId
        AND mv.id = :versionId
    `, { modelId, versionId });

    return rows;
  }

  async getAvailability(
    assetId: number,
    versionId: number,
    start: Date,
    end: Date
  ) {
    await this.db.checkConnection();

    if (!start || !end || end <= start) {
      throw new Error("Invalid time range");
    }

    // 1️⃣ Validar asset + versão
    const [assetRows]: any = await this.db.connection.execute(`
      SELECT id
      FROM assets
      WHERE id = :assetId
      AND model_version_id = :versionId
      LIMIT 1
    `, { assetId, versionId });

    if (!assetRows.length) {
      throw new Error("Asset not found for this model version");
    }

    // 2️⃣ Verificar conflitos
    const [rows]: any = await this.db.connection.execute(`
      SELECT id, status, start_time, end_time
      FROM res_reservations
      WHERE asset_id = :assetId
      AND status IN ('approved','in_use','no_show')
      AND start_time < :end
      AND end_time > :start
    `, {
      assetId,
      start,
      end
    });

    return {
      available: rows.length === 0,
      conflicts: rows
    };
  }

  async getAssetByGuid(guid: string, versionId: number) {
    await this.db.checkConnection();

    const [rows]: any = await this.db.connection.execute(`
      SELECT a.*
      FROM assets a
      INNER JOIN entities e
        ON a.model_entity_id = e.id
      WHERE e.guid = :guid
        AND e.model_version_id = :versionId
        AND a.model_version_id = :versionId
      LIMIT 1
    `, { guid, versionId });

    return rows[0] || null;
  }
}

export default new AssetDatabase();
