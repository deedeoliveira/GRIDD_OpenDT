export type AccountStatus = "active" | "suspended" | "disabled";
export interface ApplicationIdentity { accountId: number; accountUuid: string; accountKey: string; displayLabel: string; accountStatus: AccountStatus; sessionUuid: string; provider: "local_synthetic_session"; identityResolved: true; authenticationAssurance: "development_only"; expiresAt: string; }
export interface ApplicationAccount { id: number; account_uuid: string; account_key: string; normalized_account_key: string; display_label: string; status: AccountStatus; account_kind: "human" | "service"; disabled_at: Date | null; }
export class ApplicationIdentityError extends Error { constructor(readonly code: string, message: string, readonly httpStatus = 401) { super(message); } }
