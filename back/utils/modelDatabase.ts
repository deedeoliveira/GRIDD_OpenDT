import MySQLDatabase from "./mysqlDatabase.ts";
import fs from 'fs';
import type { IModelDatabase } from "../types/database.ts";
import type { LinkedModel, Model } from "../types/models.ts";
import path from "path";

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
            const [rows] = await this.db.connection.query(`
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

            const linkedModel = rows[0] as LinkedModel;

            if (linkedModel.childrenIds) {
                linkedModel.childModels = await Promise.all(linkedModel.childrenIds.split(',').map(async (id: string) => this.getModelMetadata(id)));
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
            const [rows] = await this.db.connection.query(`
                    SELECT  id,
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

        const filePath = `${this.MODELS_ROOT_PATH}/${id}.ifc`;

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
                const [linkedRows] = await this.db.connection.query(`
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
                INSERT INTO models (name, linked_parent_id)
                VALUES (:name, :linkedParentId)
            `, {
                name,
                linkedParentId
            });

            if (!modelRows || (modelRows as any).affectedRows === 0) {
                return new Error('Error inserting model into database');
            }

            const id = (modelRows as any).insertId;

            return { id, name, linkedParentId } as Model;
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

        const [rows] = await this.db.connection.query(`
            SELECT id,
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

        const [linkedRows] = await this.db.connection.query(`
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
            if (row.childrenIds) {
                row.childModels = await Promise.all(row.childrenIds.split(',').map(async (id: string) => this.getModelMetadata(id)));
                delete row.childrenIds;
            }
        }

        return linkedRows as LinkedModel[];
    }
}

export default new ModelDatabase(MODELS_ROOT_PATH);