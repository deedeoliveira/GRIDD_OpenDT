import crypto from "node:crypto";
import type { Request } from "express";
import { ApplicationIdentityDatabase } from "./applicationIdentityDatabase.ts";
import { ApplicationIdentityError, type ApplicationIdentity } from "./applicationIdentityTypes.ts";
import type { ApplicationIdentityConfig } from "./applicationIdentityConfig.ts";

function cookie(req: Request, name: string): string | null { const raw=req.headers.cookie??""; const part=raw.split(";").map(x=>x.trim()).find(x=>x.startsWith(`${name}=`)); return part ? decodeURIComponent(part.slice(name.length+1)) : null; }
function tokenHash(token:string){ return crypto.createHash("sha256").update(token).digest("hex"); }
export class LocalSyntheticSessionIdentityProvider {
  constructor(private readonly db:ApplicationIdentityDatabase, private readonly config:ApplicationIdentityConfig) {}
  async resolveRequestIdentity(req:Request):Promise<ApplicationIdentity|null>{ const token=cookie(req,this.config.cookieName); if(!token) return null; const row=await this.db.resolveSession(tokenHash(token)); if(!row) return null; if(row.status!=="active" || new Date(row.expires_at)<=new Date()){ if(row.status==='active') await this.db.revokeSessionByHash(tokenHash(token)); return null; } if(row.account_status!=="active") return null; await this.db.touchSession(row.id); return {accountId:Number(row.application_account_id),accountUuid:row.account_uuid,accountKey:row.account_key,displayLabel:row.display_label,accountStatus:row.account_status,sessionUuid:row.session_uuid,provider:"local_synthetic_session",identityResolved:true,authenticationAssurance:"development_only",expiresAt:new Date(row.expires_at).toISOString()}; }
  async createLocalSession(accountKey:string){ if(!this.config.localLoginEnabled || this.config.production) throw new ApplicationIdentityError("local_login_disabled","Local synthetic login is disabled.",403); const account=await this.db.findAccountByKey(accountKey); if(!account || !['pg202404','TEST-ACTOR-REVOKED-001','TEST-ACCOUNT-DISABLED-001'].includes(account.account_key)) throw new ApplicationIdentityError("account_not_available","Synthetic account is not available.",404); if(account.status!=="active") throw new ApplicationIdentityError("account_disabled","This application account cannot start a session.",403); const token=crypto.randomBytes(32).toString('base64url'); const expiresAt=new Date(Date.now()+this.config.ttlSeconds*1000); const session=await this.db.createSession(Number(account.id),tokenHash(token),expiresAt); return {token,expiresAt,sessionUuid:session.sessionUuid,account}; }
  async revokeSession(req:Request):Promise<void>{ const token=cookie(req,this.config.cookieName); if(token) await this.db.revokeSessionByHash(tokenHash(token)); }
}
