import path from "node:path";
import { SemanticArtifactDatabase, type SemanticArtifactDatabasePort } from "../utils/semanticArtifactDatabase.ts";
import type { IdsProfileMetadata } from "./idsValidationTypes.ts";

export interface ActiveIdsProfileResolver {
    resolveActive(familyKey: string): Promise<IdsProfileMetadata>;
}

export class IdsProfileResolver implements ActiveIdsProfileResolver {
    constructor(
        private readonly db: SemanticArtifactDatabasePort = new SemanticArtifactDatabase(),
        private readonly artifactRoot = path.resolve(process.cwd(), process.env.SEMANTIC_ARTIFACT_ROOT ?? "../semantic/artifacts")
    ) {}

    async resolveActive(familyKey: string): Promise<IdsProfileMetadata> {
        const family = await this.db.findFamilyByKey(familyKey);
        if (!family || family.artifact_type !== "ids_profile" || family.current_artifact_id === null) {
            throw new Error(`No active governed IDS profile exists for family '${familyKey}'.`);
        }
        const artifact = await this.db.findArtifactById(Number(family.current_artifact_id));
        if (!artifact || artifact.lifecycle_status !== "active" || artifact.validation_status !== "file_verified"
            || artifact.storage_mode !== "file_executed" || artifact.named_graph_uri !== null) {
            throw new Error("The current IDS profile is not an active verified file-executed artifact.");
        }
        const absolutePath = path.resolve(this.artifactRoot, artifact.repository_relative_path);
        const rootPrefix = this.artifactRoot.endsWith(path.sep) ? this.artifactRoot : `${this.artifactRoot}${path.sep}`;
        if (!absolutePath.startsWith(rootPrefix)) throw new Error("The governed IDS profile path escapes the artifact root.");
        console.log(JSON.stringify({
            type: "ids_profile_resolved",
            profileArtifactUuid: artifact.artifact_uuid,
            profileVersion: artifact.semantic_version,
            at: new Date().toISOString(),
        }));
        return {
            artifactId: Number(artifact.id),
            artifactUuid: artifact.artifact_uuid,
            familyKey,
            version: artifact.semantic_version,
            sha256: artifact.sha256,
            absolutePath,
        };
    }
}
