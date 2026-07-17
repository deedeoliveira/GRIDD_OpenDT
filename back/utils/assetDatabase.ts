import MySQLDatabase from "./mysqlDatabase.ts";

/**
 * Consultas de ativos para as rotas públicas (Prompt 4).
 *
 * Os ativos são identidades PERSISTENTES; a presença numa versão vem de
 * asset_bindings. A "versão corrente" é sempre models.current_version_id —
 * nunca o maior id. As rotas por versão devolvem o ativo persistente com o
 * binding dessa versão (compatibilidade de payload: campos legados incluídos).
 */
class AssetDatabase {
  private db: MySQLDatabase;

  constructor() {
    this.db = new MySQLDatabase();
    this.db.connect();
  }

  async getAssetsBySpace(spaceEntityId: number, versionId: number) {
    await this.db.checkConnection();

    const [rows]: any = await this.db.connection.execute(`
      SELECT a.*, ab.id AS binding_id, ab.space_id AS binding_space_id,
             ab.space_entity_id AS current_space_entity_id_snapshot,
             ab.ifc_guid, ab.name_snapshot
      FROM asset_bindings ab
      INNER JOIN assets a ON a.id = ab.asset_id
      WHERE ab.space_entity_id = :spaceEntityId
        AND ab.model_version_id = :versionId
    `, { spaceEntityId, versionId });

    return rows;
  }

  async getAssetById(assetId: number, versionId: number) {
    await this.db.checkConnection();

    const [rows]: any = await this.db.connection.execute(`
      SELECT a.*, ab.id AS binding_id, ab.ifc_guid, ab.name_snapshot
      FROM assets a
      LEFT JOIN asset_bindings ab
        ON ab.asset_id = a.id AND ab.model_version_id = :versionId
      WHERE a.id = :assetId
      LIMIT 1
    `, { assetId, versionId });

    return rows[0] || null;
  }

  async getAssetsByModel(modelId: number, versionId: number) {
    await this.db.checkConnection();

    const [rows]: any = await this.db.connection.execute(`
        SELECT a.*, ab.id AS binding_id, ab.ifc_guid, ab.name_snapshot
        FROM asset_bindings ab
        INNER JOIN assets a ON a.id = ab.asset_id
        INNER JOIN model_versions mv ON mv.id = ab.model_version_id
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
      SELECT a.*, ab.id AS binding_id, ab.space_id AS binding_space_id
      FROM asset_bindings ab
      INNER JOIN assets a ON a.id = ab.asset_id
      WHERE ab.ifc_guid = :guid
        AND ab.model_version_id = :versionId
      LIMIT 1
    `, { guid, versionId });

    return rows[0] || null;
  }

  /**
   * Ativo persistente do elemento selecionado no viewer: entity da versão
   * CORRENTE (models.current_version_id) → asset_binding → asset.
   */
  async getAssetByGuidLatest(modelId: number, guid: string) {
    await this.db.checkConnection();

    const [rows]: any = await this.db.connection.execute(`
      SELECT a.*, ab.id AS binding_id, ab.space_id AS binding_space_id,
             ab.model_version_id AS binding_version_id
      FROM models m
      INNER JOIN asset_bindings ab ON ab.model_version_id = m.current_version_id
      INNER JOIN entities e ON e.id = ab.model_entity_id AND e.guid = :guid
      INNER JOIN assets a ON a.id = ab.asset_id
      WHERE m.id = :modelId
      LIMIT 1
    `, { modelId, guid });

    return rows[0] || null;
  }
}

export default new AssetDatabase();
