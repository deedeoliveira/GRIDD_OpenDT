type DecisionRow = {
  decision_type?: 'approved' | 'rejected' | 'cancelled' | null;
  decision_status?: string | null;
  decision_reason?: string | null;
  decision_created_at?: string | Date | null;
  manager_role_snapshot?: string | null;
};

const decisionType = (value: DecisionRow['decision_type']) =>
  value === 'approved' ? 'approve' : value === 'rejected' ? 'reject' : value === 'cancelled' ? 'cancel' : null;

export const studentReservationsSql = `SELECT r.id,r.asset_id,r.status,r.start_time,r.end_time,a.asset_code,a.name,e.shadow_eligibility_outcome,
  d.decision_type,d.new_status AS decision_status,d.reason AS decision_reason,d.created_at AS decision_created_at,d.manager_role_snapshot
  FROM res_reservations r
  JOIN assets a ON a.id=r.asset_id
  LEFT JOIN reservation_semantic_evidence_links l ON l.reservation_id=r.id
  LEFT JOIN semantic_evidence_runs e ON e.id=l.evidence_run_id
  LEFT JOIN reservation_decisions d ON d.id=(SELECT d2.id FROM reservation_decisions d2
    WHERE d2.reservation_id=r.id AND d2.new_status=r.status
    ORDER BY d2.created_at DESC,d2.id DESC LIMIT 1)
  WHERE r.application_account_id=:accountId ORDER BY r.id DESC`;

export function toStudentReservation(row: Record<string, unknown>) {
  const decisionRow = row as DecisionRow;
  const type = decisionType(decisionRow.decision_type);
  return {
    id: row.id,
    asset_id: row.asset_id,
    status: row.status,
    start_time: row.start_time,
    end_time: row.end_time,
    asset_code: row.asset_code,
    name: row.name,
    shadow_eligibility_outcome: row.shadow_eligibility_outcome,
    decision: type ? {
      type,
      status: decisionRow.decision_status ?? row.status,
      reason: decisionRow.decision_reason ?? null,
      decidedAt: decisionRow.decision_created_at ?? null,
      decidedByRole: decisionRow.manager_role_snapshot ?? null,
    } : null,
  };
}
