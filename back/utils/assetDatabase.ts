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

  async getAvailability(assetId: number, start: Date, end: Date) {
    await this.db.checkConnection();

    // Converte para formato MySQL (YYYY-MM-DD HH:mm:ss)
    const formatDate = (d: Date) => {
      const pad = (n: number) => n.toString().padStart(2, "0");

      return (
        d.getFullYear() +
        "-" +
        pad(d.getMonth() + 1) +
        "-" +
        pad(d.getDate()) +
        " " +
        pad(d.getHours()) +
        ":" +
        pad(d.getMinutes()) +
        ":" +
        pad(d.getSeconds())
      );
    };

    const startFormatted = formatDate(start);
    const endFormatted = formatDate(end);

    console.log("REQUEST START:", startFormatted);
    console.log("REQUEST END:", endFormatted);

    const [rows]: any = await this.db.connection.execute(
      `
      SELECT id
      FROM res_reservations
      WHERE asset_id = :assetId
        AND status IN ('approved', 'in_use')
        AND start_time < :end
        AND end_time > :start
      `,
      {
        assetId,
        start: startFormatted,
        end: endFormatted
      }
    );

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

  async getAssetByGuidLatest(modelId: number, guid: string) {
    await this.db.checkConnection();

    // Buscar última versão
    const [versionRows]: any = await this.db.connection.execute(`
      SELECT id
      FROM model_versions
      WHERE model_id = :modelId
      ORDER BY id DESC
      LIMIT 1
    `, { modelId });

    if (!versionRows.length) return null;

    const versionId = versionRows[0].id;

    // Buscar asset na versão
    const [rows]: any = await this.db.connection.execute(`
      SELECT a.*
      FROM assets a
      INNER JOIN entities e ON a.model_entity_id = e.id
      WHERE e.guid = :guid
      AND e.model_version_id = :versionId
      AND a.model_version_id = :versionId
      LIMIT 1
    `, { guid, versionId });

    console.log("modelId:", modelId);
    console.log("versionRows:", versionRows);
    console.log("versionId:", versionId);
    console.log("guid:", guid);
    console.log("rows:", rows);


    return rows[0] || null;
  }




}

export default new AssetDatabase();
