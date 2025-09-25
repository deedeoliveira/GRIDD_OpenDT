import mysql from "mysql2/promise";
import type { ConnectionOptions } from "mysql2/promise";
import type { IDatabase } from "../types/database.ts";

class MySQLDatabase implements IDatabase {
    connection: mysql.Connection = null as any;
    private options: ConnectionOptions;

    constructor() {
        if (!process.env.DB_HOST || !process.env.DB_PORT || !process.env.DB_NAME || !process.env.DB_USER || !process.env.DB_PASSWORD) {
            throw new Error('Database configuration is not complete');
        }

        this.options = {
            host: process.env.DB_HOST,
            port: Number(process.env.DB_PORT),
            database: process.env.DB_NAME,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            charset: 'utf8mb4'
            // ssl: {
            //     rejectUnauthorized: true
            // }
        };
    }

    async connect(): Promise<void> {
        if (this.connection) return;

        this.connection = await mysql.createConnection(this.options);
        this.connection.config.namedPlaceholders = true;
    }

    async disconnect(): Promise<void> {
        if (this.connection)
        await this.connection.end();
    }

    async checkConnection(): Promise<void> {
        if (!this.connection) {
            await this.connect();

            if (!this.connection) {
                throw new Error('Database connection failed');
            }
        }
    }
}

export default MySQLDatabase;