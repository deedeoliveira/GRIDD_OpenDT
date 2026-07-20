export type IdsValidationMode = "disabled" | "report_only" | "required";

export interface IdsValidationConfig {
    enabled: boolean;
    mode: IdsValidationMode;
    familyKey: string;
    demoMode: boolean;
    timeoutMs: number;
}

function booleanValue(value: string | undefined, name: string): boolean {
    const normalized = (value ?? "false").trim().toLowerCase();
    if (!new Set(["true", "false", "1", "0"]).has(normalized)) throw new Error(`${name} must be true or false`);
    return normalized === "true" || normalized === "1";
}

export function loadIdsValidationConfig(env: NodeJS.ProcessEnv = process.env): IdsValidationConfig {
    const mode = (env.IDS_VALIDATION_MODE ?? "disabled").trim() as IdsValidationMode;
    if (!new Set(["disabled", "report_only", "required"]).has(mode)) {
        throw new Error("IDS_VALIDATION_MODE must be disabled, report_only, or required");
    }
    const enabled = booleanValue(env.IDS_VALIDATION_ENABLED, "IDS_VALIDATION_ENABLED");
    if (!enabled && mode !== "disabled") throw new Error("IDS_VALIDATION_ENABLED must be true when IDS_VALIDATION_MODE is not disabled");
    return {
        enabled,
        mode: enabled ? mode : "disabled",
        familyKey: (env.IDS_PROFILE_FAMILY_KEY ?? "oswadt-ifc4-model-requirements").trim(),
        demoMode: booleanValue(env.IDS_DEMO_MODE, "IDS_DEMO_MODE"),
        timeoutMs: Number(env.IDS_VALIDATION_TIMEOUT_MS ?? 30000),
    };
}
