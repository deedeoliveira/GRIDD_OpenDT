/**
 * Infraestrutura mínima para testes de caracterização.
 *
 * As classes de base de dados (reservationDatabase, assetDatabase, inventoryDatabase)
 * são singletons que criam a ligação MySQL no momento do import. Para caracterizar o
 * comportamento atual sem uma base de dados real, substituímos mysql.createConnection
 * por uma ligação falsa ANTES de importar dinamicamente esses módulos.
 *
 * A ligação falsa regista todas as queries (SQL + parâmetros) e responde segundo
 * um handler configurável por teste. Isto documenta o comportamento atual — incluindo
 * o SQL exato enviado — sem alterar o código da aplicação.
 */
import mysql from "mysql2/promise";

export type Call = { sql: string; params?: any };

export class FakeConnection {
    calls: Call[] = [];
    transactions: string[] = [];
    config: any = {};

    /** Handler configurável por teste: recebe (sql, params) e devolve o resultado no formato mysql2 ([rows] ou [result]). */
    handler: (sql: string, params?: any) => any = () => [[]];

    async execute(sql: string, params?: any) {
        this.calls.push({ sql, params });
        return this.handler(sql, params);
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
    }

    /** Devolve as chamadas cujo SQL corresponde à regex. */
    callsMatching(re: RegExp): Call[] {
        return this.calls.filter((c) => re.test(c.sql));
    }
}

export const fakeConnection = new FakeConnection();

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

    (mysql as any).createConnection = async () => fakeConnection;
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
