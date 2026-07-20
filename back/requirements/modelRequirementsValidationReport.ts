import type { IdsValidationMode } from "./idsValidationConfig.ts";
import type { NormalizedRequirementFinding } from "./idsValidationTypes.ts";

export type LayerStatus = "pass" | "fail" | "error" | "not_evaluated";

export interface ModelRequirementsValidationReport {
    runUuid: string;
    correlationId: string;
    mode: IdsValidationMode;
    overallStatus: "pass" | "fail" | "error";
    idsStatus: LayerStatus;
    projectRulesStatus: LayerStatus;
    blocking: boolean;
    fileSha256: string;
    ifcSchema: string | null;
    profile: null | {
        artifactId: number | null;
        artifactUuid: string;
        familyKey: string;
        version: string;
        sha256: string;
    };
    executor: null | { name: string; version: string };
    findings: NormalizedRequirementFinding[];
    startedAt: string;
    completedAt: string;
}
