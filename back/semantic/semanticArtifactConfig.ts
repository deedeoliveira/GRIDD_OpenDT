import path from "node:path";
import { SemanticArtifactError } from "./artifactTypes.ts";

export interface SemanticArtifactConfig {
    loadingEnabled: boolean;
    rootDir: string;
    manifestPath: string;
}

export function loadSemanticArtifactConfig(
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd()
): SemanticArtifactConfig {
    const loadingValue = (env.SEMANTIC_ARTIFACT_LOADING_ENABLED ?? "false").trim().toLowerCase();
    if (!new Set(["true", "false", "1", "0"]).has(loadingValue)) {
        throw new SemanticArtifactError("configuration_error", "SEMANTIC_ARTIFACT_LOADING_ENABLED must be true or false");
    }
    const rootDir = path.resolve(cwd, (env.SEMANTIC_ARTIFACT_ROOT ?? "../semantic/artifacts").trim());
    const manifestName = (env.SEMANTIC_ARTIFACT_PUBLIC_MANIFEST ?? "semantic-artifacts-public-manifest.json").trim();
    if (path.isAbsolute(manifestName) || manifestName.split(/[\\/]+/).includes("..")) {
        throw new SemanticArtifactError("configuration_error", "SEMANTIC_ARTIFACT_PUBLIC_MANIFEST must be a filename inside the semantic artifact root");
    }
    return {
        loadingEnabled: loadingValue === "true" || loadingValue === "1",
        rootDir,
        manifestPath: path.join(rootDir, manifestName),
    };
}
