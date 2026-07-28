export type AccountStatus = "active" | "suspended" | "disabled";
export interface ApplicationIdentity { accountId: number; accountUuid: string; accountKey: string; displayLabel: string; accountStatus: AccountStatus; sessionUuid: string; provider: "local_synthetic_session"; identityResolved: true; authenticationAssurance: "development_only"; expiresAt: string; }
export interface ApplicationAccount { id: number; account_uuid: string; account_key: string; normalized_account_key: string; display_label: string; status: AccountStatus; account_kind: "human" | "service"; disabled_at: Date | null; }
export class ApplicationIdentityError extends Error { constructor(readonly code: string, message: string, readonly httpStatus = 401) { super(message); } }

// Canonical additive roles. reservation_manager is a transitional database
// compatibility key only; it is never exposed by the API (normalised to
// operational_manager) and never written to new snapshots/setup.
export type CanonicalRole = "bim_manager" | "operational_manager";
export interface Capabilities {
  reserveResources: boolean;
  bimManagement: boolean;
  operationalManagement: boolean;
}
// applicationArea is a temporary compatibility alias only; it must not be used
// as the authority for route access (that is now the explicit capabilities).
export interface AccountAuthorization {
  roles: CanonicalRole[];
  capabilities: Capabilities;
  applicationArea: "manager" | "student";
}
