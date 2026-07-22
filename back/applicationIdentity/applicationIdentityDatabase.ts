import crypto from "node:crypto";
import MySQLDatabase from "../utils/mysqlDatabase.ts";
import { normalizeActorKey } from "../semantic/actorInstitutionalLinkTypes.ts";
import type { ApplicationAccount } from "./applicationIdentityTypes.ts";
import { toMysqlUtc } from '../utils/utcTime.ts';

export class ApplicationIdentityDatabase {
  constructor(private readonly db = new MySQLDatabase()) { void this.db.connect(); }
  async upsertAccount(input: { accountKey: string; displayLabel: string; status: "active"|"suspended"|"disabled"; }): Promise<ApplicationAccount> {
    const key = normalizeActorKey(input.accountKey); await this.db.checkConnection();
    await this.db.connection.execute(`INSERT INTO application_accounts (account_uuid,account_key,normalized_account_key,display_label,status,account_kind,disabled_at)
      VALUES (:uuid,:key,:normalized,:label,:status,'human',IF(:status='disabled',NOW(3),NULL))
      ON DUPLICATE KEY UPDATE display_label=VALUES(display_label),status=VALUES(status),disabled_at=IF(VALUES(status)='disabled',COALESCE(disabled_at,NOW(3)),NULL)`,
      { uuid: crypto.randomUUID(), key: key.original, normalized: key.normalized, label: input.displayLabel, status: input.status });
    return (await this.findAccountByKey(key.original))!;
  }
  async findAccountByKey(accountKey: string): Promise<ApplicationAccount | null> { const key=normalizeActorKey(accountKey); await this.db.checkConnection(); const [rows]:any=await this.db.connection.execute("SELECT * FROM application_accounts WHERE normalized_account_key=:key LIMIT 1",{key:key.normalized}); return rows[0]??null; }
  async findAccountById(id: number): Promise<ApplicationAccount | null> { await this.db.checkConnection(); const [rows]:any=await this.db.connection.execute("SELECT * FROM application_accounts WHERE id=:id LIMIT 1",{id}); return rows[0]??null; }
  async listLocalAccounts(): Promise<ApplicationAccount[]> { await this.db.checkConnection(); const [rows]:any=await this.db.connection.execute("SELECT * FROM application_accounts WHERE account_key IN ('pg202404','pg202405','TEST-ACTOR-REVOKED-001','TEST-ACCOUNT-DISABLED-001','manager-demo-001') ORDER BY account_key"); return rows; }
  async createSession(accountId:number, tokenHash:string, expiresAt:Date):Promise<{sessionUuid:string}> { await this.db.checkConnection(); const sessionUuid=crypto.randomUUID(); await this.db.connection.execute("INSERT INTO application_sessions (session_uuid,application_account_id,token_hash,status,expires_at,created_by_provider) VALUES (:sessionUuid,:accountId,:tokenHash,'active',:expiresAt,'local_synthetic_session')",{sessionUuid,accountId,tokenHash,expiresAt:toMysqlUtc(expiresAt)}); return {sessionUuid}; }
  async resolveSession(tokenHash:string):Promise<any|null>{ await this.db.checkConnection(); const [rows]:any=await this.db.connection.execute(`SELECT s.*,a.account_uuid,a.account_key,a.display_label,a.status AS account_status FROM application_sessions s JOIN application_accounts a ON a.id=s.application_account_id WHERE s.token_hash=:tokenHash LIMIT 1`,{tokenHash}); return rows[0]??null; }
  async touchSession(id:number):Promise<void>{ await this.db.connection.execute("UPDATE application_sessions SET last_seen_at=NOW(3) WHERE id=:id",{id}); }
  async revokeSessionByHash(tokenHash:string):Promise<void>{ await this.db.connection.execute("UPDATE application_sessions SET status='revoked',revoked_at=NOW(3) WHERE token_hash=:tokenHash AND status='active'",{tokenHash}); }
  async bindCurrentLink(accountId:number, actorKey:string, agentUri:string):Promise<void>{ await this.db.connection.execute(`UPDATE actor_institutional_links l JOIN (SELECT id FROM semantic_artifacts WHERE id=(SELECT current_artifact_id FROM semantic_artifact_families WHERE family_key='uminho-institutional-synthetic-data' LIMIT 1)) a ON a.id=l.institutional_dataset_artifact_id SET l.application_account_id=:accountId WHERE l.actor_key_normalized=:actorKey AND l.institutional_agent_uri=:agentUri AND l.status IN ('verified','revoked')`,{accountId,actorKey:normalizeActorKey(actorKey).normalized,agentUri}); }
  async assertLinkedAccount(accountId:number, actorKey:string):Promise<void>{
    await this.db.checkConnection();
    const normalized=normalizeActorKey(actorKey).normalized;
    const [rows]:any=await this.db.connection.execute(`SELECT id FROM actor_institutional_links
      WHERE application_account_id=:accountId AND actor_key_normalized=:actorKey AND status IN ('verified','revoked') LIMIT 1`,{accountId,actorKey:normalized});
    if(!rows.length) throw new Error("The resolved application account is not linked to this institutional actor.");
  }
  async applicationArea(accountId:number):Promise<'manager'|'student'|'none'>{
    await this.db.checkConnection();
    const [rows]:any=await this.db.connection.execute(`SELECT 1 FROM application_account_roles ar
      JOIN application_roles r ON r.id=ar.application_role_id AND r.normalized_role_key='reservation_manager'
      JOIN application_accounts a ON a.id=ar.application_account_id AND a.status='active'
      WHERE ar.application_account_id=:accountId AND ar.revoked_at IS NULL LIMIT 1`,{accountId});
    return rows.length ? 'manager' : 'student';
  }
  async disconnect(): Promise<void> { await this.db.disconnect(); }
}
