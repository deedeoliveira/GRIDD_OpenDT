import "dotenv/config";
import { loadApplicationIdentityConfig } from "../applicationIdentity/applicationIdentityConfig.ts";
import { ApplicationIdentityDatabase } from "../applicationIdentity/applicationIdentityDatabase.ts";

const accounts=[
  {accountKey:"pg202404",displayLabel:"Synthetic verified student",status:"active" as const,agent:"https://example.org/uminho-phd/test/institutional/TestStudentPhD001"},
  {accountKey:"TEST-ACTOR-REVOKED-001",displayLabel:"Synthetic revoked-link student",status:"active" as const,agent:"https://example.org/uminho-phd/test/institutional/TestResearcher001"},
  {accountKey:"TEST-ACCOUNT-DISABLED-001",displayLabel:"Synthetic disabled account",status:"disabled" as const,agent:""},
];
async function main(){ const execute=process.argv.includes('--execute'); const config=loadApplicationIdentityConfig(); if(config.mode!=="local_session"||!config.localLoginEnabled) throw new Error("Local identity setup requires APPLICATION_IDENTITY_MODE=local_session and LOCAL_SYNTHETIC_LOGIN_ENABLED=true."); if(config.production) throw new Error("Local identity setup is refused in production."); const db=new ApplicationIdentityDatabase(); try { if(execute){ for(const a of accounts){const account=await db.upsertAccount(a); if(a.agent) await db.bindCurrentLink(Number(account.id),a.accountKey,a.agent); }} console.log(JSON.stringify({ok:true,dryRun:!execute,accounts:accounts.map(a=>({accountKey:a.accountKey,status:a.status})),url:"http://localhost:3000/login",migrationsAppliedBySetup:0,reservationsCreated:0},null,2)); } finally { await db.disconnect(); } }
main().catch(error=>{console.error(JSON.stringify({ok:false,message:String(error.message??error)}));process.exit(1)});
