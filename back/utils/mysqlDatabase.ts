import mysql from "mysql2/promise";
import type { PoolOptions, Pool, PoolConnection } from "mysql2/promise";
import type { IDatabase } from "../types/database.ts";
import { ConcurrencyError, logConcurrencyEvent } from "./concurrencyControl.ts";

/**
 * Acesso MySQL (revisto no Prompt 6 — CONCURRENCY_AUDIT.md §1/§8).
 *
 * Antes: UMA conexão partilhada por instância — transações de fluxos
 * concorrentes entrelaçavam-se (o BEGIN do segundo comitava implicitamente a
 * transação do primeiro) e SELECT ... FOR UPDATE nunca serializava pedidos do
 * mesmo processo (locks de linha são por conexão).
 *
 * Agora: POOL de conexões.
 *  - `connection` continua a existir como fachada de execução simples
 *    (pool.execute/pool.query) — queries avulsas não mudam de forma;
 *  - transações correm SEMPRE numa conexão DEDICADA via withTransaction();
 *  - secções críticas que atravessam I/O externo (ex.: SQL→grafo→SQL) usam
 *    withNamedLock() — GET_LOCK numa conexão dedicada, válido entre pedidos
 *    do mesmo processo E entre processos.
 */
class MySQLDatabase implements IDatabase {
    pool: Pool = null as any;
    private options: PoolOptions;

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
            charset: 'utf8mb4',
            namedPlaceholders: true,
            // dimensionamento documentado (CONCURRENCY_AUDIT §9): locks
            // nomeados seguram uma conexão durante I/O ao grafo
            connectionLimit: 10,
        };
    }

    /** Fachada de execução simples (compatível com o uso existente). */
    get connection(): Pool {
        return this.pool;
    }

    async connect(): Promise<void> {
        if (this.pool) return;
        this.pool = mysql.createPool(this.options);
    }

    async disconnect(): Promise<void> {
        if (this.pool) await this.pool.end();
    }

    async checkConnection(): Promise<void> {
        if (!this.pool) {
            await this.connect();
            if (!this.pool) {
                throw new Error('Database connection failed');
            }
        }
    }

    /**
     * Executa `fn` numa transação em conexão DEDICADA (begin/commit/rollback/
     * release). É a ÚNICA forma suportada de abrir transações — nunca chamar
     * beginTransaction na fachada `connection` (entrelaçaria fluxos).
     */
    async withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
        await this.checkConnection();
        const conn = await this.pool.getConnection();
        try {
            await conn.beginTransaction();
            const result = await fn(conn);
            await conn.commit();
            return result;
        } catch (error) {
            try { await conn.rollback(); } catch { /* conexão pode ter caído */ }
            throw error;
        } finally {
            conn.release();
        }
    }

    /**
     * Secção crítica sob lock NOMEADO do MySQL (GET_LOCK) numa conexão
     * dedicada — serializa entre pedidos do processo e entre processos.
     * Timeout excedido ⇒ ConcurrencyError('lock_timeout') SEM retry automático
     * (o cliente decide repetir). O lock é libertado em finally.
     */
    async withNamedLock<T>(name: string, timeoutSeconds: number, fn: () => Promise<T>): Promise<T> {
        await this.checkConnection();
        const conn = await this.pool.getConnection();
        let acquired = false;
        try {
            const [rows]: any = await conn.query(
                "SELECT GET_LOCK(:name, :timeoutSeconds) AS acquired",
                { name, timeoutSeconds }
            );
            acquired = Number(rows?.[0]?.acquired) === 1;
            if (!acquired) {
                logConcurrencyEvent("lock_timeout", { lockName: name, timeoutSeconds });
                throw new ConcurrencyError(
                    "lock_timeout",
                    `another operation holds the lock for this resource — try again shortly`
                );
            }
            return await fn();
        } finally {
            if (acquired) {
                try { await conn.query("SELECT RELEASE_LOCK(:name) AS released", { name }); }
                catch { /* a conexão vai ser libertada de qualquer forma */ }
            }
            conn.release();
        }
    }
}

export default MySQLDatabase;
