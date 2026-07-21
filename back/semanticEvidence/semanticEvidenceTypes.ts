import type { VisibleShaclConstraint, SemanticValidationResultRow } from "../semanticValidation/semanticValidationTypes.ts";

export type EvidenceStatus = "available" | "unavailable" | "indeterminate";
export type StructuralEvidenceStatus = "conforms" | "nonconformant" | "missing" | "indeterminate";
export type ShadowOutcome = "eligible" | "not_eligible" | "indeterminate";
export type SqlAvailabilityStatus = "available" | "conflict";

export interface SemanticEvidenceInputs {
    actorKey: string;
    assetId: number;
    start: string;
    end: string;
}

export interface ActorEvidenceView {
    status: EvidenceStatus;
    reason: string | null;
    linkId: number | null;
    linkUuid: string | null;
    linkStatus: string;
    agentUri: string | null;
    organizations: Array<{ uri: string; label: string }>;
    roles: Array<{ uri: string; label: string; allowed: boolean }>;
    institutionalArtifactId: number | null;
    institutionalArtifactUuid: string | null;
    institutionalVersion: string | null;
    datasetCurrent: boolean | null;
}

export interface ResourceEvidenceView {
    status: EvidenceStatus;
    reason: string | null;
    assetId: number;
    assetUuid: string | null;
    assetUri: string | null;
    tag: string | null;
    location: string | null;
    modelVersionId: number | null;
    modelVersionUuid: string | null;
    modelVersionUri: string | null;
    materialisationId: number | null;
    materialisationUuid: string | null;
    graphUri: string | null;
    manifestationGuid: string | null;
    manifestationUri: string | null;
}

export interface StructuralEvidenceView {
    status: StructuralEvidenceStatus;
    validationRunId: number | null;
    validationRunUuid: string | null;
    shapesArtifactId: number | null;
    shapesVersion: string | null;
}

export interface PolicySelection {
    artifactId: number;
    artifactUuid: string;
    familyKey: string;
    filename: string;
    version: string;
    sha256: string;
    namedGraphUri: string;
    turtle: string;
    constraints: VisibleShaclConstraint[];
    executorName: string;
    executorVersion: string;
}

export interface SemanticEvidenceResponse {
    runUuid: string;
    inputs: { actorKey: string; assetId: number; assetUuid: string | null; start: string; end: string };
    actorEvidence: ActorEvidenceView;
    resourceEvidence: ResourceEvidenceView;
    structuralEvidence: StructuralEvidenceView;
    semanticEligibility: {
        mode: "shadow";
        outcome: ShadowOutcome;
        policyFilename: string;
        policyVersion: string;
        policyHash: string;
        constraints: VisibleShaclConstraint[];
        findings: SemanticValidationResultRow[];
    };
    availability: {
        authority: "sql";
        status: SqlAvailabilityStatus;
        conflicts: Array<{ kind: "asset_blocking_state" | "actor_overlap"; message: string }>;
    };
    evidenceGraph: { uri: string; sha256: string };
    policyReportGraph: { uri: string; sha256: string };
    operationalEffect: { reservationCreated: false; semanticResultWasBinding: false };
    createdAt: string;
    expiresAt: string;
    caveats: string[];
}

export interface ResourceSemanticRow {
    asset_id: number;
    asset_uuid: string | null;
    tag: string | null;
    location: string | null;
    model_version_id: number | null;
    version_uuid: string | null;
    materialisation_id: number | null;
    materialisation_uuid: string | null;
    named_graph_uri: string | null;
    ifc_guid: string | null;
    structural_validation_run_id: number | null;
    structural_validation_run_uuid: string | null;
    structural_conforms: number | boolean | null;
    shapes_artifact_id: number | null;
    shapes_version: string | null;
}

export class SemanticEvidenceError extends Error {
    constructor(readonly code: string, message: string, readonly httpStatus = 400, options?: ErrorOptions) {
        super(message, options);
        this.name = "SemanticEvidenceError";
    }
}

export function sanitizedSemanticEvidenceError(error: unknown) {
    if (error instanceof SemanticEvidenceError) return { code: error.code, message: error.message.slice(0, 500) };
    return { code: "semantic_evidence_failed", message: "Semantic evidence could not be completed." };
}
