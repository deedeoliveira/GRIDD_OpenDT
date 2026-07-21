import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { LocalSyntheticSessionIdentityProvider } from "../../applicationIdentity/localSyntheticSessionIdentityProvider.ts";

const active = { id: 7, account_uuid: "00000000-0000-4000-8000-000000000007", account_key: "pg202404", normalized_account_key: "pg202404", display_label: "Synthetic verified student", status: "active", account_kind: "human", disabled_at: null } as const;

class FakeIdentityDatabase {
    sessions = new Map<string, any>();
    async findAccountByKey(key: string) { return key === active.account_key ? active : key === "TEST-ACCOUNT-DISABLED-001" ? { ...active, account_key: key, status: "disabled" as const } : null; }
    async createSession(accountId: number, tokenHash: string, expiresAt: Date) { const sessionUuid = crypto.randomUUID(); this.sessions.set(tokenHash, { id: this.sessions.size + 1, session_uuid: sessionUuid, application_account_id: accountId, token_hash: tokenHash, status: "active", expires_at: expiresAt, account_uuid: active.account_uuid, account_key: active.account_key, display_label: active.display_label, account_status: "active" }); return { sessionUuid }; }
    async resolveSession(hash: string) { return this.sessions.get(hash) ?? null; }
    async touchSession() {}
    async revokeSessionByHash(hash: string) { const row = this.sessions.get(hash); if (row) row.status = "revoked"; }
}

function request(cookie?: string) { return { headers: { cookie } } as any; }
function provider(db: FakeIdentityDatabase) { return new LocalSyntheticSessionIdentityProvider(db as any, { enabled: true, mode: "local_session", cookieName: "local", ttlSeconds: 3600, localLoginEnabled: true, production: false }); }

test("local synthetic provider stores only a token hash and resolves then revokes a session", async () => {
    const db = new FakeIdentityDatabase(); const subject = provider(db);
    const created = await subject.createLocalSession("pg202404");
    const hash = crypto.createHash("sha256").update(created.token).digest("hex");
    assert.equal(db.sessions.has(hash), true); assert.equal([...db.sessions.keys()].includes(created.token), false);
    assert.equal((await subject.resolveRequestIdentity(request(`local=${created.token}`)))?.accountKey, "pg202404");
    await subject.revokeSession(request(`local=${created.token}`));
    assert.equal(await subject.resolveRequestIdentity(request(`local=${created.token}`)), null);
});

test("disabled accounts cannot start sessions and separate logins receive separate opaque tokens", async () => {
    const db = new FakeIdentityDatabase(); const subject = provider(db);
    await assert.rejects(() => subject.createLocalSession("TEST-ACCOUNT-DISABLED-001"), /cannot start a session/);
    const first = await subject.createLocalSession("pg202404"); const second = await subject.createLocalSession("pg202404");
    assert.notEqual(first.token, second.token); assert.equal(db.sessions.size, 2);
});
