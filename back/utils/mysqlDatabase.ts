import mysql from "mysql2/promise";
import type { PoolOptions, Pool, PoolConnection } from "mysql2/promise";
import type { IDatabase } from "../types/database.ts";
import { ConcurrencyError, logConcurrencyEvent, sanitizeErrorCause } from "./concurrencyControl.ts";

/**
 * A lock-name source for {@link MySQLDatabase.withNamedLock}. Either a literal
 * server-wide name, or a FACTORY that derives it FROM the dedicated connection that
 * will hold GET_LOCK (ADR-0051 §3-v4) — e.g. from that connection's `SELECT
 * DATABASE()` — so the value that scopes the lock and the session that holds it are
 * guaranteed to be the same connection, never two different pool connections.
 */
export type LockNameSource = string | ((conn: PoolConnection) => string | Promise<string>);

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
            // MySQL DATETIME is stored by application convention as UTC. This
            // makes mysql2 serialize JavaScript Date parameters in UTC too.
            timezone: 'Z',
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

    /** Destroy a dedicated connection, swallowing any failure (last-resort disposal). */
    private destroyQuietly(conn: PoolConnection): void {
        try { conn.destroy(); } catch { /* already broken */ }
    }

    /** Destroy a dedicated connection, RETURNING any failure so it is never silently ignored (§2.6). */
    private destroyReporting(conn: PoolConnection): unknown {
        try { conn.destroy(); return undefined; } catch (error) { return error; }
    }

    /**
     * Secção crítica sob lock NOMEADO do MySQL (GET_LOCK) numa conexão dedicada —
     * serializa entre pedidos do processo e entre processos.
     *
     * Semântica explícita de aquisição/libertação (ADR-0051 §1/§2/§3-v4):
     *  - o NOME é resolvido NA conexão dedicada (aceita uma factory que a recebe), pelo
     *    que o âmbito do lock (ex.: SELECT DATABASE()) e a sessão que o segura são a MESMA;
     *  - GET_LOCK = 1 ⇒ adquirido; a conexão dedicada segura o lock (session-scoped);
     *  - GET_LOCK = 0 ⇒ timeout ⇒ ConcurrencyError('lock_timeout') SEM retry; nada ficou
     *    seguro, por isso a conexão é DEVOLVIDA ao pool — mas se `release()` falhar é
     *    DESTRUÍDA (o timeout continua a ser o resultado primário; a falha de limpeza é
     *    reportada, nunca mascara o timeout);
     *  - GET_LOCK erro/NULL ⇒ resultado de aquisição DESCONHECIDO (o servidor pode ter
     *    adquirido o lock antes de a resposta se perder): a conexão é DESTRUÍDA (nunca
     *    devolvida ao pool) e é lançado ConcurrencyError('lock_error') DISTINTO do timeout,
     *    preservando a causa sanitizada (sem segredos);
     *  - RELEASE_LOCK = 1 ⇒ libertado; conexão devolvida ao pool para reutilização;
     *  - RELEASE_LOCK = 0/NULL/erro (ou `release()` a falhar depois de confirmado) ⇒ o lock
     *    pode continuar seguro nesta sessão, por isso a conexão é DESTRUÍDA e o resultado é
     *    ConcurrencyError('lock_release_failed'); uma falha do próprio destroy é reportada
     *    como metadado, nunca ignorada;
     *  - o erro do callback é SEMPRE o erro primário e NUNCA é substituído por uma falha de
     *    libertação; valores lançados que não sejam Error são normalizados para um Error
     *    estável (a causa original vai em `cause`); uma falha simultânea de libertação anexa
     *    `lockReleaseFailed=true`/`lockReleaseErrorCode`/mensagem sanitizada.
     */
    async withNamedLock<T>(name: LockNameSource, timeoutSeconds: number, fn: () => Promise<T>): Promise<T> {
        await this.checkConnection();
        const conn = await this.pool.getConnection();

        // ---- resolve the lock name ON the dedicated connection (§3-v4) ----
        let lockName: string;
        try {
            lockName = typeof name === "function" ? await name(conn) : name;
        } catch (error) {
            // Name derivation failed BEFORE any GET_LOCK — nothing is held. Return the
            // connection to the pool (destroy if that fails) and rethrow the original error.
            try { conn.release(); } catch { this.destroyQuietly(conn); }
            throw error;
        }

        // ---- acquire ----
        let raw: unknown;
        try {
            const [rows]: any = await conn.query("SELECT GET_LOCK(:name, :timeoutSeconds) AS acquired", { name: lockName, timeoutSeconds });
            raw = rows?.[0]?.acquired;
        } catch (error) {
            // §1.A: the GET_LOCK query itself threw. The acquisition OUTCOME IS UNKNOWN —
            // the server may have taken the lock before the response was lost — so the
            // session must NOT return to the pool. DESTROY it and raise a typed lock_error.
            this.destroyQuietly(conn);
            logConcurrencyEvent("lock_error", { lockName, acquisitionOutcome: "unknown" });
            throw new ConcurrencyError("lock_error",
                "the named lock could not be acquired (the lock query failed and the acquisition outcome is unknown)",
                sanitizeErrorCause(error));
        }
        if (raw === null || raw === undefined) {
            // §1.B: NULL = an error occurred during GET_LOCK; the acquisition state is
            // likewise UNKNOWN, so DESTROY the session rather than risk pooling a held lock.
            this.destroyQuietly(conn);
            logConcurrencyEvent("lock_error", { lockName, acquisitionOutcome: "unknown", nullResult: true });
            throw new ConcurrencyError("lock_error", `the named lock could not be evaluated (NULL result); the acquisition outcome is unknown`);
        }
        if (Number(raw) !== 1) {
            // §1.C: timeout. Nothing is held → safe to RETURN to the pool. If release()
            // itself fails, DESTROY the connection. lock_timeout stays the primary result;
            // a cleanup failure is reported, never masks the timeout.
            try {
                conn.release();
                logConcurrencyEvent("lock_timeout", { lockName, timeoutSeconds });
            } catch {
                this.destroyQuietly(conn);
                logConcurrencyEvent("lock_timeout", { lockName, timeoutSeconds, connectionCleanupFailed: true });
            }
            throw new ConcurrencyError("lock_timeout", `another operation holds the lock for this resource — try again shortly`);
        }

        // ---- acquired (GET_LOCK=1): run the callback (capture, never let it be hidden) ----
        let callbackError: unknown;
        let callbackFailed = false;
        let result: T | undefined;
        try { result = await fn(); }
        catch (error) { callbackError = error; callbackFailed = true; }

        // ---- release: RELEASE_LOCK must confirm 1; otherwise DESTROY the session ----
        let releaseError: ConcurrencyError | undefined;
        let destroyError: unknown;
        try {
            const [rl]: any = await conn.query("SELECT RELEASE_LOCK(:name) AS released", { name: lockName });
            if (Number(rl?.[0]?.released) !== 1) {
                releaseError = new ConcurrencyError("lock_release_failed",
                    `RELEASE_LOCK did not confirm release (got ${JSON.stringify(rl?.[0]?.released)})`);
            }
        } catch (error) {
            releaseError = new ConcurrencyError("lock_release_failed",
                "the named lock could not be released (the release query failed)", sanitizeErrorCause(error));
        }
        if (releaseError) {
            // The dedicated session may still hold the named lock → DESTROY it so the server
            // ends the session and frees the lock server-side. A destroy failure is reported.
            destroyError = this.destroyReporting(conn);
            logConcurrencyEvent("lock_release_failed", { lockName, connectionDestroyFailed: destroyError !== undefined });
        } else {
            // RELEASE_LOCK confirmed → return to the pool. If the close/release itself fails,
            // that too is a release failure: destroy it (always released OR destroyed).
            try {
                conn.release();
            } catch (error) {
                releaseError = new ConcurrencyError("lock_release_failed",
                    "the named lock was released but the connection could not be returned to the pool", sanitizeErrorCause(error));
                destroyError = this.destroyReporting(conn);
                logConcurrencyEvent("lock_release_failed", { lockName, connectionDestroyFailed: destroyError !== undefined });
            }
        }

        // ---- outcome: callback error dominates and is NEVER replaced (§2) ----
        if (callbackFailed) {
            // Normalize non-Error throwables so compensation metadata is always attachable,
            // preserving the original throwable as `cause`. An Error is kept by identity.
            const primary: any = callbackError instanceof Error
                ? callbackError
                : Object.assign(new Error(`operation under named lock failed: ${String(callbackError)}`), { cause: callbackError });
            if (releaseError) {
                // A simultaneous release failure is reported as structured metadata, never
                // as the thrown error (which stays the callback error).
                try {
                    primary.lockReleaseFailed = true;
                    primary.lockReleaseErrorCode = releaseError.code;
                    primary.lockReleaseMessage = releaseError.message;
                    if (destroyError !== undefined) primary.lockConnectionDestroyFailed = true;
                } catch { /* frozen error object */ }
            }
            throw primary;
        }
        if (releaseError) {
            // Callback succeeded but release failed → ConcurrencyError('lock_release_failed').
            if (destroyError !== undefined) (releaseError as any).lockConnectionDestroyFailed = true;
            throw releaseError;
        }
        return result as T;
    }
}

export default MySQLDatabase;
