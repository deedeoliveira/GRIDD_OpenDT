import type { ExtractedIfcModel } from "../requirements/modelRequirementsTypes.ts";
import type { IdsProfileMetadata, NormalizedRequirementFinding } from "../requirements/idsValidationTypes.ts";
import type { SemanticValidationReport } from "../semanticValidation/semanticValidationTypes.ts";

export type MaterialisationMode = "disabled" | "best_effort" | "required";

export interface VisibleIdsRequirement {
    requirementId: string;
    specification: string;
    appliesTo: string;
    requires: string;
    cardinality: string;
    expectedPattern: string | null;
}

export interface IntakeProfile extends IdsProfileMetadata {
    source: "governed_active_profile" | "temporary_uploaded_profile";
    originalFilename: string;
    executorName: string;
    executorVersion: string;
    specificationCount: number;
    requirements: VisibleIdsRequirement[];
}

/** Stage 0B persistent-space resolution status for an IfcSpace candidate. */
export type PreviewSpaceStatus =
    | "existing"
    | "new"
    | "invalid"
    | "missing_reference"
    | "transitional_reference_collision"
    | "schema_error";

/**
 * Stable machine-readable code for a preview outcome (ADR-0051 §7, Stage 0B §2/§3).
 * Exposed alongside a concise operational message so the BIM Manager UI never has
 * to parse prose — and never sees raw SQL or internal stack traces.
 */
export type PreviewSpaceCode =
    | "existing"
    | "new"
    | "invalid_globalid"
    | "duplicate_candidate_globalid"
    | "missing_reference"
    | "transitional_reference_collision"
    | "canonical_schema_missing"
    | "canonical_inconsistency";

export interface PreviewSpace {
    persistentUuid: string | "candidate";
    /** Candidate Reference (current administrative metadata; still required). */
    reference: string;
    label: string | null;
    ifcGuid: string;
    ifcClass: "IfcSpace";
    storey: string | null;
    persistentUri: string;
    manifestationUri: string;
    // ---- Stage 0B (ADR-0051): GlobalId is the identity authority ----
    // Optional so the RDF/version-resource builders (which project already-persisted
    // versions) are unaffected; the intake preview always populates every field.
    /** IfcSpace.GlobalId — the persistent identity key (exact, case-sensitive). */
    ifcGlobalId?: string;
    /**
     * IFC entity occurrence id (ADR-0051 §3-v3). Distinguishes two IfcSpace occurrences
     * that share one GlobalId; used only for the manifestation/candidate URI and
     * diagnostics — NEVER a persistent identity source. Null when the display-only
     * fallback (no lossless list) was used.
     */
    ifcEntityId?: number | null;
    name?: string | null;
    longName?: string | null;
    /** Resolution against existing persistent identity by GlobalId. */
    persistentSpaceStatus?: PreviewSpaceStatus;
    /** Stable machine-readable code paired with the status (§7). */
    blockingCode?: PreviewSpaceCode | null;
    /** Existing persistent space when matched by GlobalId. */
    existingSpaceId?: number | null;
    existingSpaceUuid?: string | null;
    /** Current stored Reference of the matched persistent space (if existing). */
    existingReference?: string | null;
    /** True when the candidate Reference differs from the stored current Reference. */
    referenceChanged?: boolean;
    /** Populated for a blocking status (transitional_reference_collision/invalid). */
    blockingError?: string | null;
}

export interface PreviewAsset {
    persistentUuid: string | "candidate";
    tag: string;
    serialNumber: string | null;
    manufacturer: string | null;
    ifcGuid: string;
    ifcClass: string;
    containingSpace: string | null;
    persistentUri: string;
    manifestationUri: string;
}

export interface RdfPreview {
    mappingProfile: string;
    mappingVersion: string;
    plannedGraphRole: "model_version_immutable_named_graph";
    turtleSha256: string;
    tripleCount: number;
    spaceCount: number;
    assetCount: number;
    manifestationCount: number;
    warnings: string[];
    spaces: PreviewSpace[];
    assets: PreviewAsset[];
    sampleTriples: string[];
    turtle: string;
}

export interface PreflightRun {
    runUuid: string;
    correlationId: string;
    createdAt: string;
    expiresAt: string;
    modelId: number;
    ifc: {
        originalFilename: string;
        serverComputedSha256: string;
        byteSize: number;
        detectedIfcSchema: string | null;
        entityCounts: Record<string, number>;
    };
    ids: Omit<IntakeProfile, "absolutePath">;
    validation: {
        overallStatus: "pass" | "fail" | "error";
        idsStatus: "pass" | "fail" | "error" | "not_evaluated";
        projectRulesStatus: "pass" | "fail" | "error" | "not_evaluated";
        blocking: boolean;
        findings: NormalizedRequirementFinding[];
    };
    rdfPreview: RdfPreview;
    shaclValidation?: SemanticValidationReport;
    extractedModel: ExtractedIfcModel;
}

export interface IfcRdfMappingProfile {
    profileKey: string;
    version: string;
    description: string;
    executionModel: "declarative_allowlist";
    namespaces: Record<string, string>;
    includedIfcClasses: string[];
    includedProperties: string[];
    uriPatterns: Record<string, string>;
    rdfClasses: Record<string, string>;
    predicates: string[];
    identityRules: Record<string, string>;
    provenanceRules: string[];
    deliberatelyExcluded: string[];
}
