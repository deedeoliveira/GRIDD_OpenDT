import MySQLDatabase from "./mysqlDatabase.ts";
import fs from 'fs';
import type { IModelDatabase } from "../types/database.ts";
import type { LinkedModel, Model, StudentModelContext } from "../types/models.ts";
import path from "path";
import crypto from "node:crypto";
import { resolveStorageKey } from "./storage.ts";

const MODELS_ROOT_PATH = path.join(import.meta.dirname, '../cdn_resources/models');

class ModelDatabase implements IModelDatabase {
    private MODELS_ROOT_PATH = './cdn_resources/models';
    private db: MySQLDatabase;

    constructor(root_path?: string) {
        if (root_path) this.MODELS_ROOT_PATH = root_path;
        this.db = new MySQLDatabase();
        this.db.connect();
    }

    async getLinkedModelMetadata(id: string): Promise<LinkedModel | Error> {
        await this.db.checkConnection();

        try {
            const [rows]: any = await this.db.connection.query(`
                    SELECT  linked_models.id,
                            linked_models.name,
                            GROUP_CONCAT(models.id) AS childrenIds
                    FROM linked_models
                    LEFT JOIN models
                    ON linked_models.id = models.linked_parent_id
                    WHERE linked_models.id = :id
                    GROUP BY linked_models.id
            `, { id });

            if (!rows || rows.length === 0) {
                return new Error('No linked models found');
            }

            const linkedModel = rows[0] as LinkedModel & { childrenIds?: string };

            if (linkedModel.childrenIds) {
                linkedModel.childModels = await Promise.all(linkedModel.childrenIds.split(',').map(async (id: string) => this.getModelMetadata(id))) as Model[];
                delete linkedModel.childrenIds;
            }

            return linkedModel;
        } catch (error: any) {
            return new Error(`Error fetching linked model metadata: ${error.message}`);
        }
    }

    async getModelMetadata(id: string): Promise<Model | Error> {
        await this.db.checkConnection();

        try {
            const [rows]: any = await this.db.connection.query(`
                    SELECT  id,
                            model_uuid,
                            name,
                            linked_parent_id
                    FROM models
                WHERE id = :id
            `, { id });

            if (!rows || rows.length === 0) {
                return new Error(`Model with id ${id} not found`);
            }

            return rows[0] as Model;
        } catch (error: any) {
            return new Error(`Error fetching model with id ${id}: ${error.message}`);
        }
    }

    async downloadModel(id: string): Promise<Buffer | Error> {
        const modelData = await this.getModelMetadata(id);

        if (modelData instanceof Error) {
            return new Error(`Error fetching model information: ${modelData.message}`);
        }

        // Ficheiro corrente = storage_key da versão corrente explícita
        // (Prompt 2). Fallback para o layout legado models/<id>.ifc apenas
        // quando o modelo ainda não tem versão corrente com storage_key.
        let filePath: string | null = null;

        try {
            const [rows]: any = await this.db.connection.execute(`
                SELECT v.storage_key
                FROM models m
                LEFT JOIN model_versions v ON v.id = m.current_version_id
                WHERE m.id = :id
                LIMIT 1
            `, { id });

            if (rows.length && rows[0].storage_key) {
                filePath = resolveStorageKey(rows[0].storage_key);
            }
        } catch (error: any) {
            return new Error(`Error resolving current version file: ${error.message}`);
        }

        if (!filePath) {
            filePath = `${this.MODELS_ROOT_PATH}/${id}.ifc`;
        }

        if (!fs.existsSync(filePath)) {
            return new Error(`Model file ${filePath} not found`);
        }

        const data = fs.readFileSync(filePath);

        if (!data) {
            return new Error(`Error reading model file ${filePath}`);
        }

        return data;
    }

    async uploadModel(name: string, buffer: Buffer, linkedParentId?: string, modelId?: string): Promise<Model | Error> {
        await this.db.checkConnection();

        if (!linkedParentId) {
            try {
                const [linkedRows]: any = await this.db.connection.query(`
                    INSERT INTO linked_models (name)
                    VALUES (:name)
                `, { name: name });

                linkedParentId = (linkedRows as any).insertId;
            } catch (error: any) {
                return new Error(`Error creating linked model: ${error.message}`);
            }
        }

        try {
            const [modelRows] = await this.db.connection.query(`
                INSERT INTO models (model_uuid, name, linked_parent_id)
                VALUES (:modelUuid, :name, :linkedParentId)
            `, {
                modelUuid: crypto.randomUUID(),
                name,
                linkedParentId
            });

            if (!modelRows || (modelRows as any).affectedRows === 0) {
                return new Error('Error inserting model into database');
            }

            const id = (modelRows as any).insertId;

            return { id: String(id), name, linkedParentId: String(linkedParentId) } as Model;
        } catch (error: any) {
            return new Error(`Error uploading model: ${error.message}`);
        }
    }

    async deleteModel(id: string): Promise<boolean | Error> {
        await this.db.checkConnection();

        try {
            const [rows] = await this.db.connection.query(`
                DELETE FROM models
                WHERE id = :id
            `, { id });

            if (!rows || (rows as any).affectedRows === 0) {
                return new Error(`Model with id ${id} not found`);
            }

            const filePath = `${this.MODELS_ROOT_PATH}/${id}.ifc`;

            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }

            return true;
        } catch (error: any) {
            return new Error(`Error deleting model with id ${id}: ${error.message}`);
        }
    }

    async deleteLinkedModel(id: string): Promise<boolean | Error> {
        await this.db.checkConnection();

        try {
            const [rows] = await this.db.connection.query(`
                DELETE FROM linked_models
                WHERE id = :id
            `, { id });

            if (!rows || (rows as any).affectedRows === 0) {
                return new Error(`Linked model with id ${id} not found`);
            }

            return true;
        } catch (error: any) {
            return new Error(`Error deleting linked model with id ${id}: ${error.message}`);
        }
    }

    // TODO: Implement authentication / authorization
    async listModels(): Promise<Partial<Model>[] | Error> {
        await this.db.checkConnection();

        const [rows]: any = await this.db.connection.query(`
            SELECT id,
                    model_uuid AS modelUuid,
                    name,
                    linked_parent_id AS linkedParentId
            FROM models
        `);

        if (!rows || rows.length === 0) {
            return [];
        }

        return rows as Partial<Model>[];
    }

    // TODO: Implement authentication / authorization


    async listLinkedModels(): Promise<LinkedModel[] | Error> {
        await this.db.checkConnection();

        const [linkedRows]: any = await this.db.connection.query(`
            SELECT  linked_models.id,
                    linked_models.name,
                    GROUP_CONCAT(models.id) AS childrenIds
            FROM linked_models
            LEFT JOIN models
            ON linked_models.id = models.linked_parent_id
            GROUP BY linked_models.id
        `);

        if (!linkedRows || linkedRows.length === 0) {
            return [];
        }

        for (const row of linkedRows as any[]) {

            row.childModels = [];

            if (row.childrenIds) {
                const ids = row.childrenIds.split(',');

                for (const id of ids) {
                    const model = await this.getModelMetadata(id);

                    if (!(model instanceof Error)) {
                        row.childModels.push(model);
                    }
                }
            }

            delete row.childrenIds;
        }

        return linkedRows as LinkedModel[];
    }

    /**
     * Safe read contract for the student viewer.  The three identifiers are
     * deliberately named because linked_models.id, models.id and
     * model_versions.id are different concepts.
     */
    async listStudentModelContexts(): Promise<StudentModelContext[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT m.id AS model_line_id, m.model_uuid, m.name AS model_line_name,
                   lm.id AS linked_model_id, lm.name AS linked_model_name,
                   cv.id AS current_version_id, cv.version_number AS current_version_number,
                   cv.status AS current_version_status,
                   (SELECT COUNT(*) FROM model_versions count_v WHERE count_v.model_id = m.id) AS version_count,
                   lv.id AS latest_version_id, lv.status AS latest_version_status,
                   lv.created_at AS latest_version_created_at, lv.failure_reason AS latest_version_failure_reason
            FROM models m
            INNER JOIN linked_models lm ON lm.id = m.linked_parent_id
            LEFT JOIN model_versions cv ON cv.id = m.current_version_id
            LEFT JOIN model_versions lv ON lv.id = (
                SELECT latest.id FROM model_versions latest
                WHERE latest.model_id = m.id
                ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
            )
            ORDER BY (cv.id IS NULL), lm.name ASC, m.name ASC, m.id ASC
        `);
        return rows.map((row: any) => {
            const failure = String(row.latest_version_failure_reason ?? "");
            const safeFailure = failure
                .replace(/[A-Za-z]:[\\/][^\s]+/g, "[path removed]")
                .replace(/(?:[\\/][\w.-]+){3,}/g, "[path removed]")
                .slice(0, 240);
            const stageMatch = safeFailure.match(/(?:stage|etapa)\s*[:=]\s*([\w-]+)/i);
            return {
                modelLineId: Number(row.model_line_id),
                modelLineUuid: String(row.model_uuid),
                modelLineName: String(row.model_line_name),
                linkedModelId: Number(row.linked_model_id),
                linkedModelName: String(row.linked_model_name),
                currentVersionId: row.current_version_id == null ? null : Number(row.current_version_id),
                currentVersionNumber: row.current_version_number == null ? null : Number(row.current_version_number),
                currentVersionStatus: row.current_version_status ?? null,
                versionCount: Number(row.version_count ?? 0),
                latestVersion: row.latest_version_id == null ? null : {
                    id: Number(row.latest_version_id),
                    status: String(row.latest_version_status),
                    createdAt: row.latest_version_created_at ? new Date(row.latest_version_created_at).toISOString() : null,
                    failureStage: stageMatch?.[1] ?? null,
                    message: safeFailure || null,
                },
            };
        });
    }


}

export default new ModelDatabase(MODELS_ROOT_PATH);
