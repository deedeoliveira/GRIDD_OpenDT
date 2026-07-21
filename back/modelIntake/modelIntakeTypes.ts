import type { ExtractedIfcModel } from "../requirements/modelRequirementsTypes.ts";
import type { IdsProfileMetadata, NormalizedRequirementFinding } from "../requirements/idsValidationTypes.ts";

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

export interface PreviewSpace {
    persistentUuid: string | "candidate";
    reference: string;
    label: string | null;
    ifcGuid: string;
    ifcClass: "IfcSpace";
    storey: string | null;
    persistentUri: string;
    manifestationUri: string;
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
