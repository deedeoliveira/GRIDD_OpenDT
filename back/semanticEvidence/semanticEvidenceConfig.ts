import path from "node:path";

export type SemanticEligibilityMode = "disabled" | "shadow";

export interface SemanticEvidenceConfig {
    enabled: boolean;
    mode: SemanticEligibilityMode;
    policyFamilyKey: string;
    demoMode: boolean;
    maxAgeSeconds: number;
    artifactRoot: string;
}

function bool(name: string, fallback = false): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    return raw.trim().toLowerCase() === "true";
}

export function loadSemanticEvidenceConfig(): SemanticEvidenceConfig {
    const rawMode = (process.env.SEMANTIC_ELIGIBILITY_MODE ?? "disabled").trim();
    if (rawMode !== "disabled" && rawMode !== "shadow") {
        throw new Error("SEMANTIC_ELIGIBILITY_MODE must be disabled or shadow.");
    }
    const maxAgeSeconds = Number(process.env.SEMANTIC_EVIDENCE_MAX_AGE_SECONDS ?? 900);
    if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 30 || maxAgeSeconds > 86400) {
        throw new Error("SEMANTIC_EVIDENCE_MAX_AGE_SECONDS must be between 30 and 86400.");
    }
    return {
        enabled: bool("SEMANTIC_EVIDENCE_ENABLED"),
        mode: rawMode,
        policyFamilyKey: (process.env.SEMANTIC_ELIGIBILITY_POLICY_FAMILY_KEY ?? "project-reservation-eligibility-shadow").trim(),
        demoMode: bool("SEMANTIC_EVIDENCE_DEMO_MODE"),
        maxAgeSeconds,
        artifactRoot: path.resolve(process.cwd(), process.env.SEMANTIC_ARTIFACT_ROOT ?? "../semantic/artifacts"),
    };
}
