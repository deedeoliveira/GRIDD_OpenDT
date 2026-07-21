import type { GraphClient } from "../graph/graphTypes.ts";

export const ARTIFACT_TYPES = [
    "ontology",
    "bridge_vocabulary",
    "shacl_shapes",
    "institutional_dataset",
    "test_fixture",
    "ids_profile",
    "ifc_rdf_mapping",
    "validation_report",
] as const;

export type SemanticArtifactType = (typeof ARTIFACT_TYPES)[number];
export type ArtifactStorageMode = "graph_backed" | "file_executed";

export const PRIVACY_CLASSIFICATIONS = [
    "public_research_artifact",
    "synthetic_runtime_data",
    "synthetic_test_only",
    "private_local",
    "requires_manual_review",
] as const;

export type PrivacyClassification = (typeof PRIVACY_CLASSIFICATIONS)[number];
export type PublicPrivacyClassification = Extract<
    PrivacyClassification,
    "public_research_artifact" | "synthetic_runtime_data" | "synthetic_test_only"
>;

export type ArtifactLifecycleStatus = "staged" | "validated" | "active" | "superseded" | "retired" | "failed";
export type ArtifactValidationStatus = "not_validated" | "integrity_validated" | "graph_verified" | "file_verified" | "failed";
export type ArtifactOperationType = "load_and_activate" | "load_without_activation" | "activate_existing" | "rollback_activation";
export type ArtifactOperationStatus =
    | "pending_validation"
    | "validated"
    | "pending_graph"
    | "graph_written"
    | "file_validated"
    | "pending_activation"
    | "completed"
    | "failed_retryable"
    | "failed_terminal";

export interface PublicArtifactManifestEntry {
    artifactKey: string;
    artifactType: SemanticArtifactType;
    familyName: string;
    semanticVersion: string;
    sourcePackageName: string;
    sourcePackageVersion: string;
    sourceReleaseStatus: string;
    sourceFilename: string;
    relativePath: string;
    sha256: string;
    byteSize: number;
    tripleCount: number;
    mediaType: "text/turtle" | "application/ids+xml" | "application/json";
    serialization: "turtle" | "ids-xml" | "json";
    storageMode: ArtifactStorageMode;
    semanticUri: string;
    privacyClassification: PublicPrivacyClassification;
    activationAllowed: boolean;
    testOnly: boolean;
}

export interface PublicArtifactManifest {
    manifestVersion: string;
    sourcePackageName: string;
    sourcePackageVersion: string;
    sourceReleaseStatus: string;
    artifacts: PublicArtifactManifestEntry[];
}

export interface IntegrityValidationSummary {
    kind: "integrity_validation";
    sha256: string;
    byteSize: number;
    expectedTripleCount: number;
    mediaType: "text/turtle" | "application/ids+xml" | "application/json";
    serialization: "turtle" | "ids-xml" | "json";
    validatedAt: string;
}

export interface GraphVerificationSummary {
    integrity: IntegrityValidationSummary;
    fusekiLoading: {
        kind: "fuseki_parsing_loading_validation";
        accepted: true;
        graphUri: string;
    };
    postLoad: {
        kind: "post_load_graph_verification";
        tripleCount: number;
        expectedResourcePresent: boolean | null;
    };
}

export interface ValidatedArtifactSource {
    entry: PublicArtifactManifestEntry;
    payload: Buffer;
    summary: IntegrityValidationSummary;
}

export interface SemanticArtifactFamilyRow {
    id: number;
    family_uuid: string;
    artifact_type: SemanticArtifactType;
    family_key: string;
    name: string;
    semantic_uri: string | null;
    privacy_policy: PrivacyClassification;
    current_artifact_id: number | null;
}

export interface SemanticArtifactRow {
    id: number;
    artifact_uuid: string;
    family_id: number;
    semantic_version: string;
    source_filename: string;
    repository_relative_path: string;
    byte_size: number;
    sha256: string;
    media_type: string;
    serialization: string;
    semantic_uri: string;
    storage_mode?: ArtifactStorageMode;
    named_graph_uri: string | null;
    executor_metadata_json?: string | Record<string, unknown> | null;
    lifecycle_status: ArtifactLifecycleStatus;
    validation_status: ArtifactValidationStatus;
    validation_summary_json: string | Record<string, unknown> | null;
    privacy_classification: PrivacyClassification;
    predecessor_artifact_id: number | null;
}

export interface SemanticArtifactLoadOperationRow {
    id: number;
    operation_uuid: string;
    idempotency_key: string;
    artifact_id: number;
    operation_type: ArtifactOperationType;
    status: ArtifactOperationStatus;
    payload_hash: string;
    attempt_count: number;
    previous_artifact_id: number | null;
    error_code: string | null;
    error_message: string | null;
}

export type SemanticArtifactErrorCode =
    | "manifest_invalid"
    | "artifact_not_found"
    | "artifact_integrity_failed"
    | "artifact_privacy_rejected"
    | "artifact_activation_forbidden"
    | "artifact_version_conflict"
    | "artifact_duplicate_content"
    | "idempotency_conflict"
    | "graph_namespace_rejected"
    | "graph_verification_failed"
    | "graph_load_failed"
    | "activation_conflict"
    | "activation_ineligible"
    | "operation_not_retryable"
    | "loading_disabled"
    | "configuration_error";

export class SemanticArtifactError extends Error {
    constructor(
        readonly code: SemanticArtifactErrorCode,
        message: string,
        readonly retryable = false,
        options: { cause?: unknown } = {}
    ) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "SemanticArtifactError";
    }
}

export interface SemanticArtifactLogger {
    info(event: string, details?: Record<string, unknown>): void;
    error(event: string, details?: Record<string, unknown>): void;
}

export interface SemanticArtifactRuntime {
    graphClient: GraphClient;
    logger: SemanticArtifactLogger;
    now(): Date;
    newUuid(): string;
}

export const jsonSemanticArtifactLogger: SemanticArtifactLogger = {
    info(event, details = {}) {
        console.log(JSON.stringify({ type: "semantic_artifact", event, ...details, at: new Date().toISOString() }));
    },
    error(event, details = {}) {
        console.error(JSON.stringify({ type: "semantic_artifact", event, ...details, at: new Date().toISOString() }));
    },
};

export function sanitizeArtifactError(error: unknown): { code: string; message: string } {
    if (error instanceof SemanticArtifactError) {
        return { code: error.code, message: error.message.slice(0, 1000) };
    }
    const candidate = error as { code?: unknown; message?: unknown };
    const code = typeof candidate?.code === "string" ? candidate.code : "unexpected_error";
    const rawMessage = typeof candidate?.message === "string" ? candidate.message : "Unexpected semantic artifact error";
    return { code: code.slice(0, 100), message: rawMessage.slice(0, 1000) };
}
