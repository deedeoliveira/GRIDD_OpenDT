import crypto from "node:crypto";
import {
    SemanticArtifactError,
    type IntegrityValidationSummary,
    type PublicArtifactManifest,
    type PublicArtifactManifestEntry,
    type ValidatedArtifactSource,
} from "./artifactTypes.ts";
import { APPROVED_PUBLIC_SOURCE_FILENAMES, type ArtifactSource } from "./publicArtifactManifest.ts";

const ALLOWED_PRIVACY = new Set(["public_research_artifact", "synthetic_runtime_data", "synthetic_test_only"]);

export class ArtifactValidationService {
    constructor(
        private readonly source: ArtifactSource,
        private readonly now: () => Date = () => new Date()
    ) {}

    async validate(entry: PublicArtifactManifestEntry, forActivation: boolean): Promise<ValidatedArtifactSource> {
        if (!APPROVED_PUBLIC_SOURCE_FILENAMES.has(entry.sourceFilename)) {
            throw new SemanticArtifactError("manifest_invalid", `artifact '${entry.sourceFilename}' is outside the approved subset`);
        }
        const expectedFormat = entry.storageMode === "graph_backed"
            ? entry.mediaType === "text/turtle" && entry.serialization === "turtle"
            : entry.artifactType === "ids_profile" && entry.mediaType === "application/ids+xml" && entry.serialization === "ids-xml";
        if (!expectedFormat) {
            throw new SemanticArtifactError("artifact_integrity_failed", "artifact storage mode and serialization are inconsistent");
        }
        if (!ALLOWED_PRIVACY.has(entry.privacyClassification)) {
            throw new SemanticArtifactError("artifact_privacy_rejected", "artifact privacy classification is not allowed for repository loading");
        }
        if (forActivation && (!entry.activationAllowed || entry.testOnly || entry.artifactType === "test_fixture")) {
            throw new SemanticArtifactError("artifact_activation_forbidden", "this artifact is test-only or not eligible for activation");
        }

        let payload: Buffer;
        try {
            payload = await this.source.read(entry.relativePath);
        } catch (error) {
            if (error instanceof SemanticArtifactError) throw error;
            throw new SemanticArtifactError("artifact_not_found", `artifact source is unavailable: '${entry.relativePath}'`, false, { cause: error });
        }
        const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
        if (sha256 !== entry.sha256) {
            throw new SemanticArtifactError("artifact_integrity_failed", `SHA-256 mismatch for '${entry.artifactKey}'`);
        }
        if (payload.byteLength !== entry.byteSize) {
            throw new SemanticArtifactError("artifact_integrity_failed", `byte-size mismatch for '${entry.artifactKey}'`);
        }

        const summary: IntegrityValidationSummary = {
            kind: "integrity_validation",
            sha256,
            byteSize: payload.byteLength,
            expectedTripleCount: entry.tripleCount,
            mediaType: entry.mediaType,
            serialization: entry.serialization,
            validatedAt: this.now().toISOString(),
        };
        return { entry, payload, summary };
    }

    async validateManifestTree(manifest: PublicArtifactManifest): Promise<ValidatedArtifactSource[]> {
        const results: ValidatedArtifactSource[] = [];
        for (const entry of manifest.artifacts) results.push(await this.validate(entry, false));

        const actualArtifacts = (await this.source.listFiles()).filter((file) => file.endsWith(".ttl") || file.endsWith(".ids"));
        const declaredArtifacts = manifest.artifacts.map((entry) => entry.relativePath).sort();
        if (JSON.stringify(actualArtifacts) !== JSON.stringify(declaredArtifacts)) {
            throw new SemanticArtifactError("manifest_invalid", "semantic artifact tree contains undeclared or missing governed files");
        }
        return results;
    }
}
