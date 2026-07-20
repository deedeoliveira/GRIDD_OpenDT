import crypto from "node:crypto";
import path from "node:path";
import { ArtifactRegistryService } from "../semantic/artifactRegistryService.ts";
import { ArtifactValidationService } from "../semantic/artifactValidation.ts";
import { loadSemanticArtifactConfig } from "../semantic/semanticArtifactConfig.ts";
import { FilesystemArtifactSource, loadPublicArtifactManifest } from "../semantic/publicArtifactManifest.ts";
import { SemanticArtifactDatabase, type SemanticArtifactDatabasePort } from "../utils/semanticArtifactDatabase.ts";
import { IfcOpenShellIdsValidationProvider } from "./ifcOpenShellIdsValidationProvider.ts";
import type { IdsProfileMetadata, IdsValidationProvider } from "./idsValidationTypes.ts";

export class IdsProfileGovernanceService {
    constructor(
        private readonly db: SemanticArtifactDatabasePort = new SemanticArtifactDatabase(),
        private readonly provider: IdsValidationProvider = new IfcOpenShellIdsValidationProvider()
    ) {}

    async validateManifestProfile(familyKey = "oswadt-ifc4-model-requirements") {
        const config = loadSemanticArtifactConfig();
        const manifest = await loadPublicArtifactManifest(config.manifestPath);
        const entry = manifest.artifacts.find((candidate) => candidate.artifactType === "ids_profile"
            && candidate.artifactKey.startsWith(`${familyKey}-`));
        if (!entry) throw new Error(`Governed IDS family '${familyKey}' is absent from the public manifest.`);
        const validator = new ArtifactValidationService(new FilesystemArtifactSource(config.rootDir));
        const validated = await validator.validate(entry, true);
        const profile: IdsProfileMetadata = {
            artifactId: null,
            artifactUuid: "manifest-validation",
            familyKey,
            version: entry.semanticVersion,
            sha256: entry.sha256,
            absolutePath: path.resolve(config.rootDir, entry.relativePath),
        };
        const executor = await this.provider.validateProfile(profile, crypto.randomUUID(), 30000);
        if (executor.profileSha256 !== entry.sha256 || executor.profileVersion !== entry.semanticVersion) {
            throw new Error("IDS executor metadata does not match the governed manifest revision.");
        }
        return { config, entry, validated, executor, profile };
    }

    async registerAndActivate(familyKey = "oswadt-ifc4-model-requirements") {
        const checked = await this.validateManifestProfile(familyKey);
        const registry = new ArtifactRegistryService(this.db);
        const registered = await registry.registerLoad({
            entry: checked.entry,
            integrity: checked.validated.summary,
            // Ignored for file_executed revisions; a constant avoids coupling
            // the IDS execution boundary to any graph configuration.
            baseUri: "http://oswadt.local/id",
            idempotencyKey: `ids-profile:${checked.entry.artifactKey}:activate`,
            activate: true,
        });
        if (registered.artifact.named_graph_uri !== null || registered.artifact.storage_mode !== "file_executed") {
            throw new Error("IDS registry revision received an invalid graph-backed storage identity.");
        }
        await this.db.markFileVerified(registered.operation.operation_uuid, Number(registered.artifact.id), {
            integrity: checked.validated.summary,
            executor: checked.executor,
            validation: { kind: "ids_executor_profile_loading", accepted: true },
        });
        await this.db.activateArtifact({
            operationUuid: registered.operation.operation_uuid,
            familyId: Number(registered.family.id),
            artifactId: Number(registered.artifact.id),
            expectedCurrentArtifactId: registered.operation.previous_artifact_id === null
                ? null : Number(registered.operation.previous_artifact_id),
        });
        return {
            artifactId: Number(registered.artifact.id),
            artifactUuid: registered.artifact.artifact_uuid,
            version: checked.entry.semanticVersion,
            sha256: checked.entry.sha256,
            storageMode: registered.artifact.storage_mode,
            namedGraphUri: registered.artifact.named_graph_uri,
            executor: checked.executor,
        };
    }
}
