import crypto from 'node:crypto';
import MySQLDatabase from '../utils/mysqlDatabase.ts';
import { getReservationSemanticEvidenceService } from '../semanticEvidence/semanticEvidenceRuntime.ts';
import { fromMysqlUtc } from '../utils/utcTime.ts';
import { normalizeActorKey } from '../semantic/actorInstitutionalLinkTypes.ts';
import { SemanticEvidenceDatabase } from '../utils/semanticEvidenceDatabase.ts';
import { loadSemanticEvidenceConfig } from '../semanticEvidence/semanticEvidenceConfig.ts';
import { ManagerReviewEvidenceDatabase, reservationInputHash } from './managerReviewEvidenceDatabase.ts';

export class ReservationApprovalError extends Error { constructor(readonly code:string,message:string,readonly httpStatus=400){super(message);} }
function reason(value: unknown, required=false) { const text=String(value??'').trim(); if(required&&!text) throw new ReservationApprovalError('decision_reason_required','A decision reason is required.'); if(text.length>1000) throw new ReservationApprovalError('decision_reason_invalid','Decision reason is too long.'); return text||null; }

export class ReservationApprovalService {
  private readonly reviews: ManagerReviewEvidenceDatabase;
  private readonly sourceCurrent: (review:any,reservation:any)=>Promise<boolean>;
  private readonly evidence: Pick<ReturnType<typeof getReservationSemanticEvidenceService>,'evaluate'|'getRun'> | undefined;
  private readonly resources: Pick<SemanticEvidenceDatabase,'resolveResource'> | undefined;
  constructor(
    private readonly db=new MySQLDatabase(),
    reviews?: ManagerReviewEvidenceDatabase,
    sourceCurrent?: (review:any,reservation:any)=>Promise<boolean>,
    evidence?: Pick<ReturnType<typeof getReservationSemanticEvidenceService>,'evaluate'|'getRun'>,
    resources?: Pick<SemanticEvidenceDatabase,'resolveResource'>
  ) { void this.db.connect(); this.reviews=reviews ?? new ManagerReviewEvidenceDatabase(); this.sourceCurrent=sourceCurrent ?? ((review,reservation)=>this.sourcesRemainCurrent(review,reservation)); this.evidence=evidence; this.resources=resources; }
  async managerScopes(accountId:number) { await this.db.checkConnection(); const [rows]:any=await this.db.connection.execute(`SELECT s.id,s.asset_id,s.scope_uuid FROM reservation_management_scopes s JOIN application_account_roles ar ON ar.application_account_id=s.application_account_id AND ar.revoked_at IS NULL JOIN application_roles r ON r.id=ar.application_role_id AND r.normalized_role_key='reservation_manager' JOIN application_accounts a ON a.id=s.application_account_id AND a.status='active' WHERE s.application_account_id=:accountId AND s.status='active'`,{accountId}); if(!rows.length) throw new ReservationApprovalError('reservation_manager_scope_denied','This account has no active reservation-management scope.',403); return rows; }
  async list(accountId:number,input:{page?:unknown;pageSize?:unknown;status?:unknown}={}) {
    const scopes=await this.managerScopes(accountId); const ids=scopes.map((s:any)=>Number(s.asset_id));
    const page=Math.max(1,Number.parseInt(String(input.page??1),10)||1); const pageSize=Math.min(100,Math.max(1,Number.parseInt(String(input.pageSize??25),10)||25));
    const requested=String(input.status??'pending'); const allowed=new Set(['all','pending','approved','rejected','cancelled','in_use','overdue','completed','no_show']);
    if(!allowed.has(requested)) throw new ReservationApprovalError('reservation_status_filter_invalid','The reservation status filter is invalid.',400);
    const statusSql=requested==='all'?'':' AND r.status=?'; const params=requested==='all'?[...ids]:[...ids,requested];
    const where=`r.asset_id IN (${ids.map(()=>'?').join(',')})${statusSql}`;
    const [countRows]:any=await this.db.connection.execute(`SELECT COUNT(*) AS totalItems FROM res_reservations r WHERE ${where}`,params);
    const totalItems=Number(countRows[0]?.totalItems??0); const totalPages=Math.max(1,Math.ceil(totalItems/pageSize)); const offset=(page-1)*pageSize;
    const [items]:any=await this.db.connection.execute(`SELECT r.*,a.asset_code,a.name,e.shadow_eligibility_outcome,e.sql_availability_status,e.created_at AS submission_evidence_created_at,e.expires_at AS submission_evidence_expires_at,d.decision_type,d.reason,d.created_at AS decision_created_at FROM res_reservations r JOIN assets a ON a.id=r.asset_id LEFT JOIN reservation_semantic_evidence_links l ON l.reservation_id=r.id LEFT JOIN semantic_evidence_runs e ON e.id=l.evidence_run_id LEFT JOIN reservation_decisions d ON d.id=(SELECT d2.id FROM reservation_decisions d2 WHERE d2.reservation_id=r.id ORDER BY d2.id DESC LIMIT 1) WHERE ${where} ORDER BY r.id DESC LIMIT ${pageSize} OFFSET ${offset}`,[...params]);
    return {items,page,pageSize,totalItems,totalPages};
  }
  private async reservation(accountId:number,reservationId:number) { const scopes=await this.managerScopes(accountId); const [rows]:any=await this.db.connection.execute(`SELECT r.* FROM res_reservations r WHERE r.id=:reservationId LIMIT 1`,{reservationId}); if(!rows.length) throw new ReservationApprovalError('reservation_not_found','Reservation was not found.',404); const row=rows[0]; if(!scopes.some((scope:any)=>Number(scope.asset_id)===Number(row.asset_id))) throw new ReservationApprovalError('reservation_manager_scope_denied','Reservation is outside this management scope.',403); return row; }
  async reviewReservation(accountId:number,sessionUuid:string,reservationId:number,force=false) {
    const reservation=await this.reservation(accountId,reservationId); const hash=reservationInputHash(reservation); const existing=await this.reviews.latest(reservationId,accountId,sessionUuid);
    if(!force && existing && this.reviews.freshness(existing) && existing.reservation_input_hash===hash && await this.sourceCurrent(existing,reservation)) return { refreshed:false, reviewEvidence:existing };
    if(existing?.status==='current' && !this.reviews.freshness(existing)) await this.reviews.markExpired(existing.id);
    else if(existing?.status==='current' && existing.reservation_input_hash!==hash) await this.reviews.markStale(existing.id,'reservation_inputs_changed');
    else if(existing?.status==='current' && !await this.sourceCurrent(existing,reservation)) await this.reviews.markStale(existing.id,'material_source_changed');
    try {
      const provider=this.evidence ?? getReservationSemanticEvidenceService();
      const evidence=await provider.evaluate({ actorKey:String(reservation.actor_id),assetId:Number(reservation.asset_id),start:fromMysqlUtc(reservation.start_time).toISOString(),end:fromMysqlUtc(reservation.end_time).toISOString(),applicationIdentity:{accountId,accountUuid:'manager-session',provider:'local_synthetic_session',assurance:'development_only'} });
      const run=await provider.getRun(evidence.runUuid);
      await this.reviews.persist({ reservationId,evidenceRunId:run.id,managerAccountId:accountId,managerSessionUuid:sessionUuid,actorLinkId:run.row.actor_link_id??null,institutionalArtifactId:run.row.institutional_artifact_id??null,modelVersionId:run.row.model_version_id??null,materialisationId:run.row.materialisation_id??null,structuralValidationRunId:run.row.structural_validation_run_id??null,policyArtifactId:Number(run.row.policy_artifact_id),inputHash:hash,expiresAt:fromMysqlUtc(run.row.expires_at) });
      if(force && existing?.status==='current') await this.reviews.markStale(existing.id,'refreshed');
      const reviewEvidence=await this.reviews.latest(reservationId,accountId,sessionUuid); return { refreshed:true, reviewEvidence };
    } catch(error) {
      if(error instanceof ReservationApprovalError) throw error;
      throw new ReservationApprovalError(force?'review_evidence_refresh_failed':'review_evidence_open_failed',force?'The review evidence could not be refreshed.':'The reservation review could not be opened.',500);
    }
  }
  async detail(accountId:number,sessionUuid:string,reservationId:number) { const row=await this.reservation(accountId,reservationId); const review=await this.reviewReservation(accountId,sessionUuid,reservationId); return { reservation:row, reviewEvidence:review.reviewEvidence, refreshed:review.refreshed }; }
  private async sourcesRemainCurrent(review:any,reservation:any):Promise<boolean> {
    const actorKey=normalizeActorKey(String(reservation.actor_id)).normalized;
    const policyFamily=loadSemanticEvidenceConfig().policyFamilyKey;
    let actorCurrent=false;
    if(review.actor_link_id) {
      const [actorRows]:any=await this.db.connection.execute(`SELECT l.id
        FROM actor_institutional_links l
        JOIN semantic_artifacts a ON a.id=l.institutional_dataset_artifact_id
        JOIN semantic_artifact_families f ON f.id=a.family_id AND f.current_artifact_id=a.id
        WHERE l.id=:linkId AND l.actor_key_normalized=:actorKey
          AND l.link_uuid=:linkUuid AND l.status=:linkStatus
          AND l.institutional_dataset_artifact_id=:institutionalArtifactId`,{
        linkId:review.actor_link_id,actorKey,linkUuid:review.actor_link_uuid_snapshot,
        linkStatus:review.actor_link_status_snapshot,institutionalArtifactId:review.institutional_artifact_id
      });
      actorCurrent=actorRows.length===1;
    } else {
      const [actorRows]:any=await this.db.connection.execute(`SELECT id FROM actor_institutional_links
        WHERE actor_key_normalized=:actorKey AND superseded_at IS NULL ORDER BY id DESC LIMIT 1`,{actorKey});
      actorCurrent=actorRows.length===0;
    }
    const [policyRows]:any=await this.db.connection.execute(`SELECT current_artifact_id FROM semantic_artifact_families WHERE family_key=:familyKey LIMIT 1`,{familyKey:policyFamily});
    const resource=await (this.resources ?? new SemanticEvidenceDatabase()).resolveResource(Number(reservation.asset_id));
    const same=(actual:unknown,expected:unknown)=>Number(actual??0)===Number(expected??0);
    return actorCurrent && same(policyRows[0]?.current_artifact_id,review.policy_artifact_id)
      && same(resource?.model_version_id,review.model_version_id)
      && same(resource?.materialisation_id,review.materialisation_id)
      && same(resource?.structural_validation_run_id,review.structural_validation_run_id);
  }
  private async markReviewStale(id:number,reason:string,connection?:any) { if(!connection) return this.reviews.markStale(id,reason); await connection.execute(`UPDATE reservation_manager_evidence_reviews SET status='stale',stale_reason=:reason WHERE id=:id AND status='current'`,{id,reason}); }
  private async currentReview(accountId:number,sessionUuid:string,reservation:any,connection?:any) { const review=await this.reviews.latest(Number(reservation.id),accountId,sessionUuid); if(!review) throw new ReservationApprovalError('review_evidence_required','Refresh evidence before deciding this reservation.',409); if(review.reservation_input_hash!==reservationInputHash(reservation)){ await this.markReviewStale(review.id,'reservation_inputs_changed',connection); throw new ReservationApprovalError('review_evidence_stale','Review evidence is stale; refresh evidence before deciding.',409); } if(!this.reviews.freshness(review)){ await this.markReviewStale(review.id,'ttl_expired',connection); throw new ReservationApprovalError('review_evidence_stale','Review evidence is stale; refresh evidence before deciding.',409); } if(!await this.sourceCurrent(review,reservation)){ await this.markReviewStale(review.id,'material_source_changed',connection); throw new ReservationApprovalError('review_evidence_stale','Review evidence is stale; refresh evidence before deciding.',409); } return review; }
  async decide(accountId:number,sessionUuid:string,reservationId:number,kind:'approved'|'rejected'|'cancelled',input:{reason?:unknown;overrideAcknowledged?:unknown}) {
    const decisionReason=reason(input.reason,kind==='rejected'||kind==='cancelled'); const scopes=await this.managerScopes(accountId);
    return this.db.withTransaction(async conn=>{
      const [rows]:any=await conn.execute(`SELECT r.* FROM res_reservations r WHERE r.id=:reservationId LIMIT 1 FOR UPDATE`,{reservationId});
      if(!rows.length) throw new ReservationApprovalError('reservation_not_found','Reservation was not found.',404); const r=rows[0]; const scope=scopes.find((s:any)=>Number(s.asset_id)===Number(r.asset_id)); if(!scope) throw new ReservationApprovalError('reservation_manager_scope_denied','Reservation is outside this management scope.',403);
      if(kind==='cancelled') {
        if(r.status==='in_use' || r.checkin_time) throw new ReservationApprovalError('reservation_already_checked_in','This reservation has already been checked in. The student must complete checkout.',409);
        if(r.status!=='pending' && r.status!=='approved') throw new ReservationApprovalError('reservation_not_cancellable','This reservation cannot be cancelled in its current lifecycle state.',409);
      } else if(r.status!=='pending') throw new ReservationApprovalError('reservation_not_pending','Only pending reservations can receive this decision.',409);
      const review=await this.currentReview(accountId,sessionUuid,r,conn);
      await conn.execute('SELECT id FROM assets WHERE id=:assetId FOR UPDATE',{assetId:r.asset_id}); let availability:'available'|'conflict'='available';
      if(kind==='approved') { const [conflicts]:any=await conn.execute(`SELECT id FROM res_reservations WHERE asset_id=:assetId AND id<>:reservationId AND status IN ('approved','in_use','no_show') AND start_time < :endTime AND end_time > :startTime LIMIT 1`,{assetId:r.asset_id,reservationId,startTime:r.start_time,endTime:r.end_time}); if(conflicts.length){availability='conflict'; throw new ReservationApprovalError('reservation_approval_conflict','SQL availability recheck found a conflicting reservation.',409);} if((review.shadow_eligibility_outcome==='not_eligible'||review.shadow_eligibility_outcome==='indeterminate') && (!input.overrideAcknowledged||!decisionReason)) throw new ReservationApprovalError('reservation_shadow_override_required','Approving shadow evidence requires acknowledgement and a reason.',409); }
      if(kind!=='approved') availability=review.sql_availability_status==='conflict'?'conflict':'available';
      const [update]:any=await conn.execute(`UPDATE res_reservations SET status=:status, approved_at=IF(:status='approved',UTC_TIMESTAMP(3),approved_at), approved_by=IF(:status='approved',:manager,approved_by) WHERE id=:reservationId AND status=:previousStatus`,{status:kind,reservationId,manager:`account:${accountId}`,previousStatus:r.status}); if(!update.affectedRows) throw new ReservationApprovalError('reservation_decision_race','Reservation decision was already made.',409);
      await conn.execute(`INSERT INTO reservation_decisions (decision_uuid,reservation_id,decision_type,previous_status,new_status,decided_by_application_account_id,manager_role_snapshot,management_scope_snapshot,semantic_evidence_run_id,semantic_outcome_snapshot,sql_availability_snapshot,reason,override_acknowledged) VALUES (:uuid,:reservationId,:kind,:previousStatus,:kind,:accountId,'reservation_manager',:scope,:evidenceId,:shadow,:availability,:reason,:override)`,{uuid:crypto.randomUUID(),reservationId,kind,previousStatus:r.status,accountId,scope:`asset:${scope.asset_id}`,evidenceId:review.evidence_run_id,shadow:review.shadow_eligibility_outcome??null,availability,reason:decisionReason,override:Boolean(input.overrideAcknowledged)});
      return {reservationId,status:kind,availability,evidenceRunUuid:review.run_uuid,reviewUuid:review.review_uuid};
    });
  }
  async endSessionReviews(sessionUuid:string) { await this.reviews.markSessionEnded(sessionUuid); }
}
