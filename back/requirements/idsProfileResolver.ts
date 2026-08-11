import path from "node:path";
import { resolvePinnedArtifactRow, type PinnedArtifactSelection } from "../modelIntake/semanticExecutionContext.ts";
import { SemanticArtifactDatabase, type SemanticArtifactDatabasePort } from "../utils/semanticArtifactDatabase.ts";
import type { IdsProfileMetadata } from "./idsValidationTypes.ts";

export interface ActiveIdsProfileResolver {
    resolveActive(familyKey: string): Promise<IdsProfileMetadata>;
}

export interface PinnedIdsProfileResolver {
    resolveByArtifactId(selection: PinnedArtifactSelection): Promise<IdsProfileMetadata>;
}

export class IdsProfileResolver implements ActiveIdsProfileResolver, PinnedIdsProfileResolver {
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

    /**
     * Change C authoritative path: resolves the IDS profile PINNED by a captured
     * SemanticExecutionContext, strictly by artifact id. `current_artifact_id` is never
     * consulted, so an administrator activating a new governed triplet mid-attempt cannot
     * change which profile this attempt executes. All integrity checks of `resolveActive`
     * are preserved unchanged (validation_status, storage_mode, named_graph_uri absence,
     * artifact-root path containment); no new file-content hash check is introduced,
     * because `resolveActive` does not perform one either.
     */
    async resolveByArtifactId(selection: PinnedArtifactSelection): Promise<IdsProfileMetadata> {
        const artifact = await resolvePinnedArtifactRow(this.db, selection);
        if (artifact.validation_status !== "file_verified" || artifact.storage_mode !== "file_executed"
            || artifact.named_graph_uri !== null) {
            throw new Error("The pinned IDS profile is not a verified file-executed artifact.");
        }
        const absolutePath = path.resolve(this.artifactRoot, artifact.repository_relative_path);
        const rootPrefix = this.artifactRoot.endsWith(path.sep) ? this.artifactRoot : `${this.artifactRoot}${path.sep}`;
        if (!absolutePath.startsWith(rootPrefix)) throw new Error("The governed IDS profile path escapes the artifact root.");
        console.log(JSON.stringify({
            type: "ids_profile_resolved_pinned",
            profileArtifactUuid: artifact.artifact_uuid,
            profileArtifactId: Number(artifact.id),
            profileVersion: artifact.semantic_version,
            at: new Date().toISOString(),
        }));
        return {
            artifactId: Number(artifact.id),
            artifactUuid: artifact.artifact_uuid,
            familyKey: selection.familyKey,
            version: artifact.semantic_version,
            sha256: artifact.sha256,
            absolutePath,
        };
    }
}
