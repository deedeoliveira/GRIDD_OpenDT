import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IdsProfileMetadata, IdsValidationProvider, IdsValidationRequest, IdsValidationResult } from "./idsValidationTypes.ts";
import { IdsValidationError } from "./idsValidationTypes.ts";

const execFileAsync = promisify(execFile);

interface PythonResult extends Partial<IdsValidationResult> {
    error?: string;
    errorType?: string;
    profileValid?: boolean;
    specificationCount?: number;
    requirementCount?: number;
    requirements?: Array<{
        requirementId: string;
        specification: string;
        appliesTo: string;
        requires: string;
        cardinality: string;
        expectedPattern: string | null;
    }>;
}

export class IfcOpenShellIdsValidationProvider implements IdsValidationProvider {
    static readonly ID = "ifcopenshell-ifctester";

    constructor(
        private readonly pythonExecutable = process.env.IDS_PYTHON_EXECUTABLE
            ?? path.resolve(process.cwd(), "python", "venv", "Scripts", "python.exe"),
        private readonly scriptPath = path.resolve(process.cwd(), "python", "ids_validate.py")
    ) {}

    private async execute(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<PythonResult> {
        try {
            const { stdout } = await execFileAsync(this.pythonExecutable, [this.scriptPath, ...args], {
                timeout: timeoutMs,
                signal,
                windowsHide: true,
                maxBuffer: 2 * 1024 * 1024,
            });
            const parsed = JSON.parse(stdout.trim()) as PythonResult;
            if (parsed.error) throw new IdsValidationError("ids_executor_rejected", parsed.error);
            return parsed;
        } catch (error: any) {
            if (error instanceof IdsValidationError) throw error;
            const code = error?.killed || error?.code === "ETIMEDOUT" ? "ids_executor_timeout" : "ids_executor_failed";
            throw new IdsValidationError(code, code === "ids_executor_timeout"
                ? "IDS validation timed out."
                : "IDS validation could not be completed.", { cause: error });
        }
    }

    async validate(request: IdsValidationRequest): Promise<IdsValidationResult> {
        const result = await this.execute([
            "--ifc", request.ifcPath,
            "--ids", request.profile.absolutePath,
            "--correlation-id", request.correlationId,
        ], request.timeoutMs, request.signal);
        const required = ["profileVersion", "profileSha256", "executorName", "executorVersion", "ifcSchema", "fileSha256"] as const;
        if (required.some((key) => typeof result[key] !== "string") || !Array.isArray(result.findings)) {
            throw new IdsValidationError("ids_executor_protocol_error", "IDS executor returned an invalid normalized report.");
        }
        return result as IdsValidationResult;
    }

    async validateProfile(profile: IdsProfileMetadata, correlationId: string, timeoutMs: number) {
        const result = await this.execute([
            "--ids", profile.absolutePath,
            "--correlation-id", correlationId,
            "--validate-profile-only",
        ], timeoutMs);
        if (result.profileValid !== true || typeof result.specificationCount !== "number" || !Array.isArray(result.requirements)) {
            throw new IdsValidationError("ids_profile_invalid", "The IDS executor did not accept the governed profile.");
        }
        return {
            profileVersion: String(result.profileVersion),
            profileSha256: String(result.profileSha256),
            executorName: String(result.executorName),
            executorVersion: String(result.executorVersion),
            specificationCount: result.specificationCount,
            requirementCount: result.requirements.length,
            requirements: result.requirements,
        };
    }
}
