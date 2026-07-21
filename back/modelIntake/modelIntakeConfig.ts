import path from "node:path";

export interface ModelIntakeConfig {
    workspaceEnabled: boolean;
    temporaryIdsUploadEnabled: boolean;
    materialisationEnabled: boolean;
    mode: "disabled" | "best_effort" | "required";
    mappingFamilyKey: string;
    maxIfcBytes: number;
    maxIdsBytes: number;
    runTtlMs: number;
    artifactRoot: string;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
    const raw = (env[name] ?? String(fallback)).trim().toLowerCase();
    if (raw !== "true" && raw !== "false" && raw !== "1" && raw !== "0") {
        throw new Error(`${name} must be true or false.`);
    }
    return raw === "true" || raw === "1";
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
    return value;
}

export function loadModelIntakeConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ModelIntakeConfig {
    const mode = (env.IFC_RDF_MATERIALISATION_MODE ?? "disabled").trim();
    if (!new Set(["disabled", "best_effort", "required"]).has(mode)) {
        throw new Error("IFC_RDF_MATERIALISATION_MODE must be disabled, best_effort, or required.");
    }
    const workspaceEnabled = bool(env, "MODEL_INTAKE_WORKSPACE_ENABLED");
    const temporaryIdsUploadEnabled = bool(env, "TEMPORARY_IDS_UPLOAD_ENABLED");
    const materialisationEnabled = bool(env, "IFC_RDF_MATERIALISATION_ENABLED");
    if (env.NODE_ENV === "production" && (workspaceEnabled || temporaryIdsUploadEnabled)) {
        throw new Error("Controlled model intake and temporary IDS upload are disabled in production by default.");
    }
    return {
        workspaceEnabled,
        temporaryIdsUploadEnabled,
        materialisationEnabled,
        mode: mode as ModelIntakeConfig["mode"],
        mappingFamilyKey: (env.IFC_RDF_MAPPING_FAMILY_KEY ?? "oswadt-ifc4-minimal-rdf-mapping").trim(),
        maxIfcBytes: positiveInt(env, "MODEL_INTAKE_MAX_IFC_BYTES", 50 * 1024 * 1024),
        maxIdsBytes: positiveInt(env, "MODEL_INTAKE_MAX_IDS_BYTES", 2 * 1024 * 1024),
        runTtlMs: positiveInt(env, "MODEL_INTAKE_RUN_TTL_MS", 30 * 60 * 1000),
        artifactRoot: path.resolve(cwd, env.SEMANTIC_ARTIFACT_ROOT ?? "../semantic/artifacts"),
    };
}
