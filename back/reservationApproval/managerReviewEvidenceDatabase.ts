import crypto from 'node:crypto';
import MySQLDatabase from '../utils/mysqlDatabase.ts';
import { fromMysqlUtc, toMysqlUtc } from '../utils/utcTime.ts';

export function reservationInputHash(row: { actor_id: string; asset_id: number; start_time: unknown; end_time: unknown }): string {
  return crypto.createHash('sha256').update(JSON.stringify({ actor: row.actor_id, asset: Number(row.asset_id),
    start: fromMysqlUtc(row.start_time).toISOString(), end: fromMysqlUtc(row.end_time).toISOString() })).digest('hex');
}

export class ManagerReviewEvidenceDatabase {
  constructor(private readonly db = new MySQLDatabase()) { void this.db.connect(); }
  async latest(reservationId: number, accountId: number, sessionUuid: string) {
    await this.db.checkConnection();
    const [rows]: any = await this.db.connection.execute(`SELECT rv.*,e.run_uuid,e.shadow_eligibility_outcome,e.sql_availability_status,e.status AS evidence_status,e.created_at AS evidence_created_at,e.expires_at AS evidence_expires_at,
      JSON_UNQUOTE(JSON_EXTRACT(e.response_json,'$.actorEvidence.linkUuid')) AS actor_link_uuid_snapshot,
      JSON_UNQUOTE(JSON_EXTRACT(e.response_json,'$.actorEvidence.linkStatus')) AS actor_link_status_snapshot
      FROM reservation_manager_evidence_reviews rv JOIN semantic_evidence_runs e ON e.id=rv.evidence_run_id
      WHERE rv.reservation_id=:reservationId AND rv.manager_application_account_id=:accountId AND rv.manager_session_uuid=:sessionUuid
      ORDER BY rv.id DESC LIMIT 1`, { reservationId, accountId, sessionUuid });
    return rows[0] ?? null;
  }
  async persist(input: { reservationId: number; evidenceRunId: number; managerAccountId: number; managerSessionUuid: string;
    actorLinkId: number | null; institutionalArtifactId: number | null; modelVersionId: number | null; materialisationId: number | null;
    structuralValidationRunId: number | null; policyArtifactId: number; inputHash: string; expiresAt: Date }) {
    await this.db.checkConnection();
    const reviewedAt = new Date();
    await this.db.connection.execute(`INSERT INTO reservation_manager_evidence_reviews
      (review_uuid,reservation_id,evidence_run_id,manager_application_account_id,manager_session_uuid,actor_link_id,institutional_artifact_id,model_version_id,materialisation_id,structural_validation_run_id,policy_artifact_id,reservation_input_hash,status,reviewed_at,expires_at)
      VALUES (:uuid,:reservationId,:evidenceRunId,:managerAccountId,:managerSessionUuid,:actorLinkId,:institutionalArtifactId,:modelVersionId,:materialisationId,:structuralValidationRunId,:policyArtifactId,:inputHash,'current',:reviewedAt,:expiresAt)`,
      { uuid: crypto.randomUUID(), ...input, reviewedAt: toMysqlUtc(reviewedAt), expiresAt: toMysqlUtc(input.expiresAt) });
  }
  async markSessionEnded(sessionUuid: string) { await this.db.checkConnection(); await this.db.connection.execute(`UPDATE reservation_manager_evidence_reviews SET status='session_ended',stale_reason='logout' WHERE manager_session_uuid=:sessionUuid AND status='current'`, { sessionUuid }); }
  async markStale(id: number, reason: string) { await this.db.checkConnection(); await this.db.connection.execute(`UPDATE reservation_manager_evidence_reviews SET status='stale',stale_reason=:reason WHERE id=:id AND status='current'`, { id, reason }); }
  async markExpired(id: number) { await this.db.checkConnection(); await this.db.connection.execute(`UPDATE reservation_manager_evidence_reviews SET status='expired',stale_reason='ttl_expired' WHERE id=:id AND status='current'`, { id }); }
  freshness(row: any, now = new Date()) { return row && row.status === 'current' && fromMysqlUtc(row.expires_at).getTime() > now.getTime(); }
}
