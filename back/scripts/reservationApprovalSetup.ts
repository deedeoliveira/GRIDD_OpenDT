import 'dotenv/config';
import crypto from 'node:crypto';
import MySQLDatabase from '../utils/mysqlDatabase.ts';
import { loadReservationApprovalConfig } from '../reservationApproval/reservationApprovalConfig.ts';
import { ApplicationIdentityDatabase } from '../applicationIdentity/applicationIdentityDatabase.ts';
import { createInstitutionalRuntime } from '../semantic/institutionalRuntime.ts';

const accounts = [
  { key: 'manager-demo-001', label: 'Synthetic reservation manager', agent: 'https://example.org/uminho-phd/test/institutional/TestProfessor001' },
  { key: 'pg202405', label: 'Synthetic verified student two', agent: 'https://example.org/uminho-phd/test/institutional/TestStudentPhD002' },
];

async function main() {
  // npm on Windows exposes an unknown `--execute` argument as npm_config_execute
  // instead of forwarding it through tsx. Accept both forms, while keeping the
  // default dry-run safe.
  const execute = process.argv.includes('--execute') || process.env.npm_config_execute === 'true';
  const config = loadReservationApprovalConfig();
  if (!config.localSetupEnabled || config.production) throw new Error('Local reservation approval setup is disabled.');
  const identities = new ApplicationIdentityDatabase();
  const db = new MySQLDatabase();
  try {
    await db.checkConnection();
    const [assets]: any = await db.connection.execute("SELECT id,asset_code FROM assets WHERE reservable=1 AND lifecycle_status='active' ORDER BY id");
    if (!assets.length) throw new Error('No synthetic reservable asset is available for manager scope.');
    const institutional = createInstitutionalRuntime();
    const dataset = await institutional.verifier.resolveCurrentInstitutionalDataset();
    const secondStudentAgentExists = await institutional.verifier.agentExists(accounts[1]!.agent, dataset);
    if (!secondStudentAgentExists) throw new Error('TestStudentPhD002 is absent from the current synthetic institutional dataset.');
    if (execute) {
      const manager = await identities.upsertAccount({ accountKey: accounts[0]!.key, displayLabel: accounts[0]!.label, status: 'active' });
      const student = await identities.upsertAccount({ accountKey: accounts[1]!.key, displayLabel: accounts[1]!.label, status: 'active' });
      await identities.bindCurrentLink(Number(manager.id), accounts[0]!.key, accounts[0]!.agent);
      const secondStudentLink = await institutional.links.createVerifiedLink({ actorKey: accounts[1]!.key,
        institutionalAgentUri: accounts[1]!.agent, verificationSource: 'reservation_approval_setup_second_student' });
      if (secondStudentLink.status !== 'verified') throw new Error('Second synthetic student link was not verified.');
      await identities.bindCurrentLink(Number(student.id), accounts[1]!.key, accounts[1]!.agent);
      await db.connection.execute(`INSERT INTO application_roles(role_key,normalized_role_key,display_label) VALUES ('reservation_manager','reservation_manager','Reservation manager') ON DUPLICATE KEY UPDATE display_label=VALUES(display_label)`);
      await db.connection.execute(`INSERT IGNORE INTO application_account_roles(application_account_id,application_role_id) SELECT :accountId,id FROM application_roles WHERE normalized_role_key='reservation_manager'`, { accountId: Number(manager.id) });
      for(const asset of assets) await db.connection.execute(`INSERT INTO reservation_management_scopes(scope_uuid,application_account_id,asset_id,status) VALUES (:uuid,:accountId,:assetId,'active') ON DUPLICATE KEY UPDATE status='active',revoked_at=NULL`, { uuid: crypto.randomUUID(), accountId: Number(manager.id), assetId: asset.id });
    }
    console.log(JSON.stringify({
      ok: true, dryRun: !execute, managerAccount: accounts[0]!.key, applicationRole: 'reservation_manager',
      secondStudent: { accountKey: accounts[1]!.key, agent: 'TestStudentPhD002', datasetArtifactId: dataset.artifactId,
        verifiedLink: execute ? 'prepared' : 'planned' }, revokedLinkAccount: 'TEST-ACTOR-REVOKED',
      scope: { kind: 'assets', assets: assets.map((asset:any)=>({ assetId:asset.id,assetCode:asset.asset_code })) },
      flags: { reservationApprovalEnabled: config.enabled, managerUiEnabled: config.managerUiEnabled, localSyntheticManagerSetupEnabled: config.localSetupEnabled },
      url: 'http://localhost:3000/dashboard/reservations', migrationsAppliedBySetup: 0, reservationsChanged: 0,
    }, null, 2));
  } finally { await identities.disconnect(); await db.disconnect(); }
}
main().then(() => process.exit(0)).catch((error) => { console.error(JSON.stringify({ ok: false, message: String(error.message ?? error) })); process.exit(1); });
