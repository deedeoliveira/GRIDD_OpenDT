/**
 * Infraestrutura mínima para testes de caracterização.
 *
 * As classes de base de dados são singletons que criam o POOL MySQL no momento
 * do import. Para caracterizar o comportamento sem uma base real, substituímos
 * mysql.createPool/createConnection por implementações falsas ANTES do import
 * dinâmico desses módulos.
 *
 * A ligação falsa regista todas as queries (SQL + parâmetros) e responde
 * segundo um handler configurável por teste.
 *
 * (Prompt 6) O fake emula agora a semântica de CONCORRÊNCIA do MySQL real:
 *  - pool.getConnection() devolve conexões de transação DEDICADAS (begin/
 *    commit/rollback continuam registados em fakeConnection.transactions);
 *  - SELECT ... FOR UPDATE adquire um lock de LINHA (chave tabela+parâmetros)
 *    detido pela conexão de transação até commit/rollback/release — outra
 *    conexão que peça o mesmo lock ESPERA (fila FIFO), como no InnoDB;
 *  - GET_LOCK/RELEASE_LOCK emulam locks NOMEADOS entre conexões.
 * Isto permite testes de corrida determinísticos: dois fluxos concorrentes
 * são serializados exatamente onde o código adquire locks — e um teste que
 * remova o lock volta a exibir a corrida.
 */
import mysql from "mysql2/promise";
import fs from "fs";
import path from "path";
import os from "os";

export type Call = { sql: string; params?: any };

/* ---------------- locks emulados (linha + nomeados) ---------------- */

interface LockState { holder: object; count: number; queue: Array<{ holder: object; resolve: () => void }> }

class KeyedLocks {
    private locks = new Map<string, LockState>();

    /** true se adquiriu já; caso contrário devolve uma promise que resolve quando adquirir. */
    acquire(key: string, holder: object): Promise<void> | null {
        const lock = this.locks.get(key);
        if (!lock) {
            this.locks.set(key, { holder, count: 1, queue: [] });
            return null;
        }
        if (lock.holder === holder) {
            lock.count += 1;
            return null;
        }
        return new Promise<void>((resolve) => lock.queue.push({ holder, resolve }));
    }

    isHeldByOther(key: string, holder: object): boolean {
        const lock = this.locks.get(key);
        return !!lock && lock.holder !== holder;
    }

    release(key: string, holder: object): void {
        const lock = this.locks.get(key);
        if (!lock || lock.holder !== holder) return;
        lock.count -= 1;
        if (lock.count > 0) return;
        const next = lock.queue.shift();
        if (next) {
            lock.holder = next.holder;
            lock.count = 1;
            next.resolve();
        } else {
            this.locks.delete(key);
        }
    }

    releaseAll(holder: object): void {
        for (const [key, lock] of [...this.locks.entries()]) {
            if (lock.holder === holder) {
                lock.count = 1; // força libertação total
                this.release(key, holder);
            }
            // remove também esperas pendentes deste holder (conexão libertada)
            lock.queue = lock.queue.filter((w) => w.holder !== holder);
        }
    }

    reset(): void {
        for (const lock of this.locks.values()) {
            for (const w of lock.queue) w.resolve();
        }
        this.locks.clear();
    }
}

/** Chave de lock de linha derivada de um SELECT ... FOR UPDATE. */
function rowLockKey(sql: string, params: any): string | null {
    if (!/FOR UPDATE\s*$/i.test(sql.trim())) return null;
    const table = /FROM\s+`?(\w+)`?/i.exec(sql)?.[1] ?? "unknown";
    return `${table}:${JSON.stringify(params ?? {})}`;
}

export class FakeConnection {
    calls: Call[] = [];
    transactions: string[] = [];
    config: any = {};
    rowLocks = new KeyedLocks();
    namedLocks = new KeyedLocks();

    /** Handler configurável por teste: recebe (sql, params) e devolve o resultado no formato mysql2 ([rows] ou [result]). */
    handler: (sql: string, params?: any) => any = () => [[]];

    /** Caminho partilhado: regista, emula locks, delega no handler. */
    async dispatch(holder: object, sql: string, params?: any) {
        this.calls.push({ sql, params });

        const getLock = /SELECT\s+GET_LOCK\s*\(/i.test(sql);
        if (getLock) {
            const name = params?.name ?? "unnamed";
            const timeout = Number(params?.timeoutSeconds ?? 0);
            if (timeout === 0 && this.namedLocks.isHeldByOther(name, holder)) {
                return [[{ acquired: 0 }]];
            }
            const wait = this.namedLocks.acquire(name, holder);
            if (wait) await wait;
            return [[{ acquired: 1 }]];
        }
        if (/SELECT\s+RELEASE_LOCK\s*\(/i.test(sql)) {
            this.namedLocks.release(params?.name ?? "unnamed", holder);
            return [[{ released: 1 }]];
        }

        const rowKey = rowLockKey(sql, params);
        if (rowKey) {
            const wait = this.rowLocks.acquire(rowKey, holder);
            if (wait) await wait;
        }

        return this.handler(sql, params);
    }

    async execute(sql: string, params?: any) {
        return this.dispatch(this, sql, params);
    }

    async query(sql: string, params?: any) {
        return this.execute(sql, params);
    }

    async beginTransaction() { this.transactions.push("begin"); }
    async commit() { this.transactions.push("commit"); }
    async rollback() { this.transactions.push("rollback"); }
    async end() { /* noop */ }

    reset() {
        this.calls = [];
        this.transactions = [];
        this.handler = () => [[]];
        this.rowLocks.reset();
        this.namedLocks.reset();
    }

    /** Devolve as chamadas cujo SQL corresponde à regex. */
    callsMatching(re: RegExp): Call[] {
        return this.calls.filter((c) => re.test(c.sql));
    }
}

export const fakeConnection = new FakeConnection();

/** Conexão de transação dedicada (pool.getConnection) — locks próprios. */
class FakeTxConnection {
    constructor(private shared: FakeConnection) {}

    async execute(sql: string, params?: any) {
        return this.shared.dispatch(this, sql, params);
    }
    async query(sql: string, params?: any) {
        return this.shared.dispatch(this, sql, params);
    }
    async beginTransaction() { this.shared.transactions.push("begin"); }
    async commit() {
        this.shared.transactions.push("commit");
        this.shared.rowLocks.releaseAll(this);
    }
    async rollback() {
        this.shared.transactions.push("rollback");
        this.shared.rowLocks.releaseAll(this);
    }
    release() {
        this.shared.rowLocks.releaseAll(this);
        this.shared.namedLocks.releaseAll(this);
    }
}

const fakePool = {
    execute: (sql: string, params?: any) => fakeConnection.execute(sql, params),
    query: (sql: string, params?: any) => fakeConnection.query(sql, params),
    getConnection: async () => new FakeTxConnection(fakeConnection),
    end: async () => { /* noop */ },
};

/**
 * Instala a ligação falsa. Tem de ser chamado antes do import dinâmico
 * dos módulos utils/*Database.ts.
 */
export function installFakeMySQL() {
    process.env.DB_HOST ??= "test-host";
    process.env.DB_PORT ??= "3306";
    process.env.DB_NAME ??= "test-db";
    process.env.DB_USER ??= "test-user";
    process.env.DB_PASSWORD ??= "test-password";

    /* ---- segurança do storage (incidente de 2026-07-17): a BD é falsa mas
            o FILESYSTEM é real. NODE_ENV=test ativa as guardas fail-safe e
            OSWADT_STORAGE_ROOT redireciona TODO o storage dos testes para um
            diretório temporário descartável — nenhum teste toca em
            back/cdn_resources. Tem de acontecer ANTES do import dinâmico de
            utils/storage.ts. ---- */
    process.env.NODE_ENV = "test";
    if (!process.env.OSWADT_STORAGE_ROOT) {
        process.env.OSWADT_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "oswadt-test-storage-"));
        fs.mkdirSync(path.join(process.env.OSWADT_STORAGE_ROOT, "models/temp"), { recursive: true });
    }

    (mysql as any).createConnection = async () => fakeConnection;
    (mysql as any).createPool = () => fakePool;
}

/**
 * Configura respostas por rota: a primeira regex que corresponder ao SQL
 * devolve o resultado associado (valor ou função (sql, params) => resultado).
 * Sem correspondência devolve [[]] (zero linhas).
 */
export function respond(routes: Array<[RegExp, any]>) {
    fakeConnection.handler = (sql: string, params?: any) => {
        for (const [re, result] of routes) {
            if (re.test(sql)) {
                return typeof result === "function" ? result(sql, params) : result;
            }
        }
        return [[]];
    };
}
