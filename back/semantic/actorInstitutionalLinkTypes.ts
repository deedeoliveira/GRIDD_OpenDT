export const ACTOR_LINK_TYPE = "represents_institutional_actor" as const;
export type ActorInstitutionalLinkType = typeof ACTOR_LINK_TYPE;
export type ActorInstitutionalLinkStatus = "pending" | "verified" | "suspended" | "revoked" | "superseded";

export interface ActorInstitutionalLinkRow {
    id: number;
    link_uuid: string;
    actor_key: string;
    actor_key_normalized: string;
    institutional_agent_uri: string;
    institutional_dataset_artifact_id: number;
    link_type: ActorInstitutionalLinkType;
    status: ActorInstitutionalLinkStatus;
    valid_from: Date | string | null;
    valid_to: Date | string | null;
    verified_at: Date | string | null;
    verification_source: string | null;
    superseded_at: Date | string | null;
    revoked_at: Date | string | null;
    created_at?: Date | string;
    updated_at?: Date | string;
}

export interface CurrentInstitutionalDataset {
    artifactId: number;
    artifactUuid: string;
    semanticVersion: string;
    namedGraphUri: string;
    familyKey: string;
}

export interface InstitutionalLinkVerifier {
    resolveCurrentInstitutionalDataset(): Promise<CurrentInstitutionalDataset>;
    agentExists(agentUri: string, dataset: CurrentInstitutionalDataset): Promise<boolean>;
}

export type ActorInstitutionalLinkErrorCode =
    | "actor_key_invalid"
    | "institutional_agent_uri_invalid"
    | "actor_link_not_found"
    | "actor_link_conflict"
    | "actor_link_not_verified"
    | "actor_link_suspended"
    | "actor_link_revoked"
    | "actor_link_expired"
    | "actor_link_superseded"
    | "actor_link_requires_reverification"
    | "institutional_artifact_not_active"
    | "institutional_agent_not_found"
    | "institutional_graph_unavailable"
    | "institutional_graph_timeout"
    | "institutional_response_invalid"
    | "institutional_feature_disabled"
    | "institutional_demo_disabled";

export class ActorInstitutionalLinkError extends Error {
    constructor(
        readonly code: ActorInstitutionalLinkErrorCode,
        message: string,
        readonly httpStatus: number = 409,
        options: { cause?: unknown } = {}
    ) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "ActorInstitutionalLinkError";
    }
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function normalizeActorKey(value: string): { original: string; normalized: string } {
    if (typeof value !== "string") throw new ActorInstitutionalLinkError("actor_key_invalid", "actor key must be a string", 400);
    const original = value.trim();
    if (original.length === 0 || original.length > 255 || CONTROL_CHARACTERS.test(original)) {
        throw new ActorInstitutionalLinkError("actor_key_invalid", "actor key must contain 1 to 255 visible characters", 400);
    }
    return { original, normalized: original.toLocaleLowerCase("en-US") };
}

export function validateInstitutionalAgentUri(value: string): string {
    if (typeof value !== "string" || value.length === 0 || value.length > 1000 || CONTROL_CHARACTERS.test(value)) {
        throw new ActorInstitutionalLinkError("institutional_agent_uri_invalid", "institutional agent URI is invalid", 400);
    }
    let parsed: URL;
    try { parsed = new URL(value); }
    catch { throw new ActorInstitutionalLinkError("institutional_agent_uri_invalid", "institutional agent URI must be absolute", 400); }
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
        throw new ActorInstitutionalLinkError("institutional_agent_uri_invalid", "institutional agent URI must use HTTP or HTTPS", 400);
    }
    return value;
}

export function sanitizedLinkError(error: unknown): { code: string; message: string } {
    if (error instanceof ActorInstitutionalLinkError) return { code: error.code, message: error.message.slice(0, 500) };
    return { code: "institutional_internal_error", message: "Institutional context operation failed" };
}
