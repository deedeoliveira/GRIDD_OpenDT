export type ValidationFindingSource = "ids" | "project_rule";
export type ValidationFindingStatus = "pass" | "fail" | "warning" | "not_evaluated";

export interface NormalizedRequirementFinding {
    source: ValidationFindingSource;
    requirementId: string;
    requirementName: string;
    status: ValidationFindingStatus;
    severity: "info" | "warning" | "error";
    entityType: string | null;
    entityGuid: string | null;
    propertySet: string | null;
    propertyName: string | null;
    expectedValue: string | null;
    actualValue: string | null;
    message: string;
}

export interface IdsProfileMetadata {
    artifactId: number | null;
    artifactUuid: string;
    familyKey: string;
    version: string;
    sha256: string;
    absolutePath: string;
}

export interface IdsValidationRequest {
    ifcPath: string;
    profile: IdsProfileMetadata;
    correlationId: string;
    timeoutMs: number;
    signal?: AbortSignal;
}

export interface IdsValidationResult {
    profileVersion: string;
    profileSha256: string;
    executorName: string;
    executorVersion: string;
    ifcSchema: string;
    fileSha256: string;
    conforms: boolean;
    requirementsEvaluated: number;
    successCount: number;
    failureCount: number;
    findings: NormalizedRequirementFinding[];
}

export interface IdsValidationProvider {
    validate(request: IdsValidationRequest): Promise<IdsValidationResult>;
    validateProfile(profile: IdsProfileMetadata, correlationId: string, timeoutMs: number): Promise<{
        profileVersion: string;
        profileSha256: string;
        executorName: string;
        executorVersion: string;
        specificationCount: number;
        requirementCount?: number;
        requirements?: Array<{
            requirementId: string;
            specification: string;
            appliesTo: string;
            requires: string;
            cardinality: string;
            expectedPattern: string | null;
        }>;
    }>;
}

export class IdsValidationError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options: { cause?: unknown } = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "IdsValidationError";
        this.code = code;
    }
}
