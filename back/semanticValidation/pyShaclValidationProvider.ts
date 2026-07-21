import { spawn } from "node:child_process";
import { loadSemanticValidationConfig } from "./semanticValidationConfig.ts";
import type { SemanticValidationProvider, SemanticValidationRequest, VisibleShaclConstraint } from "./semanticValidationTypes.ts";
import { SemanticValidationError } from "./semanticValidationTypes.ts";

interface PythonResponse {
    ok: boolean;
    errorCode?: string;
    message?: string;
    conforms?: boolean;
    resultCount?: number;
    results?: any[];
    constraints?: VisibleShaclConstraint[];
    executorName?: string;
    executorVersion?: string;
    startedAt?: string;
    completedAt?: string;
    reportTurtle?: string;
    reportSha256?: string;
}

export class PyShaclValidationProvider implements SemanticValidationProvider {
    readonly providerId = "pyshacl";

    constructor(
        private readonly pythonExecutable = loadSemanticValidationConfig().pythonExecutable,
        private readonly scriptPath = loadSemanticValidationConfig().scriptPath,
    ) {}

    private async execute(request: Partial<SemanticValidationRequest> & { shapesTurtle: string; timeoutMs: number; signal?: AbortSignal }): Promise<PythonResponse> {
        try {
            const stdout = await new Promise<string>((resolve, reject) => {
                const child = spawn(this.pythonExecutable, [this.scriptPath], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
                let output = "";
                let stderr = "";
                let settled = false;
                const finish = (error?: Error) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    request.signal?.removeEventListener("abort", abort);
                    error ? reject(Object.assign(error, { stdout: output })) : resolve(output);
                };
                const abort = () => { child.kill(); finish(Object.assign(new Error("aborted"), { name: "AbortError" })); };
                const timer = setTimeout(() => { child.kill(); finish(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })); }, request.timeoutMs);
                request.signal?.addEventListener("abort", abort, { once: true });
                child.stdout.on("data", (chunk) => {
                    output += chunk.toString();
                    if (output.length > 8 * 1024 * 1024) { child.kill(); finish(new Error("SHACL report exceeded output limit.")); }
                });
                child.stderr.on("data", (chunk) => { if (stderr.length < 2048) stderr += chunk.toString(); });
                child.on("error", finish);
                child.on("close", (code) => code === 0 ? finish() : finish(new Error(`pySHACL exited with code ${code}.`)));
                child.stdin.end(JSON.stringify(request));
            });
            const response = JSON.parse(stdout.trim()) as PythonResponse;
            if (!response.ok) throw new SemanticValidationError(response.errorCode ?? "shacl_executor_rejected", response.message ?? "SHACL input was rejected.");
            return response;
        } catch (error: any) {
            if (error instanceof SemanticValidationError) throw error;
            if (typeof error?.stdout === "string" && error.stdout.trim()) {
                try {
                    const response = JSON.parse(error.stdout.trim()) as PythonResponse;
                    throw new SemanticValidationError(response.errorCode ?? "shacl_executor_rejected", response.message ?? "SHACL input was rejected.");
                } catch (parsed) {
                    if (parsed instanceof SemanticValidationError) throw parsed;
                }
            }
            const timeout = error?.killed || error?.code === "ETIMEDOUT" || error?.name === "AbortError";
            throw new SemanticValidationError(timeout ? "shacl_executor_timeout" : "shacl_executor_failed",
                timeout ? "SHACL validation timed out." : "SHACL validation could not be completed.", { cause: error });
        }
    }

    async inspectShapes(request: Omit<SemanticValidationRequest, "dataTurtle">) {
        const response = await this.execute({ ...request, dataTurtle: "" });
        if (!Array.isArray(response.constraints) || !response.executorName || !response.executorVersion) {
            throw new SemanticValidationError("shacl_executor_protocol_error", "pySHACL returned an invalid inspection report.");
        }
        return { constraints: response.constraints, executorName: response.executorName, executorVersion: response.executorVersion };
    }

    async validate(request: SemanticValidationRequest) {
        const response = await this.execute(request);
        if (typeof response.conforms !== "boolean" || typeof response.resultCount !== "number" || !Array.isArray(response.results)
            || !Array.isArray(response.constraints) || !response.executorName || !response.executorVersion || !response.startedAt
            || !response.completedAt || !response.reportTurtle || !response.reportSha256) {
            throw new SemanticValidationError("shacl_executor_protocol_error", "pySHACL returned an invalid normalized validation report.");
        }
        return {
            conforms: response.conforms,
            resultCount: response.resultCount,
            results: response.results,
            constraints: response.constraints,
            executorName: response.executorName,
            executorVersion: response.executorVersion,
            startedAt: response.startedAt,
            completedAt: response.completedAt,
            reportTurtle: response.reportTurtle,
            reportSha256: response.reportSha256,
        };
    }
}
