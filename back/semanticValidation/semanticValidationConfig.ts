import path from "node:path";
import type { ShaclValidationMode } from "./semanticValidationTypes.ts";

function bool(value: string | undefined, name: string): boolean {
    const normalized = (value ?? "false").trim().toLowerCase();
    if (!new Set(["true", "false", "1", "0"]).has(normalized)) throw new Error(`${name} must be true or false.`);
    return normalized === "true" || normalized === "1";
}

export function loadSemanticValidationConfig(env: NodeJS.ProcessEnv = process.env) {
    const enabled = bool(env.SHACL_VALIDATION_ENABLED, "SHACL_VALIDATION_ENABLED");
    const requested = (env.SHACL_VALIDATION_MODE ?? "disabled").trim() as ShaclValidationMode;
    if (!new Set(["disabled", "report_only", "required"]).has(requested)) {
        throw new Error("SHACL_VALIDATION_MODE must be disabled, report_only, or required.");
    }
    if (!enabled && requested !== "disabled") throw new Error("SHACL_VALIDATION_ENABLED must be true when SHACL validation mode is not disabled.");
    const timeoutMs = Number(env.SHACL_VALIDATION_TIMEOUT_MS ?? 30000);
    const maxShapesBytes = Number(env.MODEL_INTAKE_MAX_IDS_BYTES ?? 2 * 1024 * 1024);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("SHACL_VALIDATION_TIMEOUT_MS is outside the allowed range.");
    if (!Number.isInteger(maxShapesBytes) || maxShapesBytes < 1024 || maxShapesBytes > 10 * 1024 * 1024) throw new Error("SHACL temporary shapes size limit is invalid.");
    return {
        enabled,
        mode: enabled ? requested : "disabled" as ShaclValidationMode,
        modelShapesFamilyKey: (env.SHACL_MODEL_SHAPES_FAMILY_KEY ?? "oswadt-model-rdf-structural-shapes").trim(),
        temporaryShapesUploadEnabled: bool(env.TEMPORARY_SHAPES_UPLOAD_ENABLED, "TEMPORARY_SHAPES_UPLOAD_ENABLED"),
        timeoutMs,
        maxShapesBytes,
        inference: "none" as const,
        advanced: true,
        metaShacl: true,
        pythonExecutable: env.SHACL_PYTHON_EXECUTABLE
            ?? env.IDS_PYTHON_EXECUTABLE
            ?? path.resolve(process.cwd(), "python", "venv", "Scripts", "python.exe"),
        scriptPath: path.resolve(process.cwd(), "python", "shacl_validate.py"),
        artifactRoot: path.resolve(process.cwd(), "../semantic/artifacts"),
    };
}
