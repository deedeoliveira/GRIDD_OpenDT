import crypto from "node:crypto";
import {
    institutionalOntologyGraphUri,
    institutionalSyntheticDataGraphUri,
    negativeFixtureGraphUri,
    projectInstitutionalBridgeGraphUri,
    structuralShapesGraphUri,
    semanticEvidenceVocabularyGraphUri,
    semanticPolicyGraphUri,
} from "../graph/namedGraphs.ts";
import type {
    EnsureLoadOperationInput,
    SemanticArtifactDatabasePort,
} from "../utils/semanticArtifactDatabase.ts";
import {
    SemanticArtifactError,
    type ArtifactOperationType,
    type IntegrityValidationSummary,
    type PublicArtifactManifestEntry,
    type SemanticArtifactFamilyRow,
    type SemanticArtifactLoadOperationRow,
    type SemanticArtifactRow,
} from "./artifactTypes.ts";

export interface RegisteredArtifactOperation {
    family: SemanticArtifactFamilyRow;
    artifact: SemanticArtifactRow;
    operation: SemanticArtifactLoadOperationRow;
}

export interface ArtifactRegistryRuntime {
    newUuid(): string;
}

function familyKey(entry: PublicArtifactManifestEntry): string {
    const suffix = `-${entry.semanticVersion}`;
    return entry.artifactKey.endsWith(suffix)
        ? entry.artifactKey.slice(0, -suffix.length)
        : entry.artifactKey;
}

function canonicalOperationHash(input: Record<string, unknown>): string {
    const ordered = Object.keys(input).sort().reduce<Record<string, unknown>>((result, key) => {
        result[key] = input[key];
        return result;
    }, {});
    return crypto.createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

export class ArtifactRegistryService {
    constructor(
        private readonly database: SemanticArtifactDatabasePort,
        private readonly runtime: ArtifactRegistryRuntime = { newUuid: () => crypto.randomUUID() }
    ) {}

    get db(): SemanticArtifactDatabasePort {
        return this.database;
    }

    private graphUri(
        entry: PublicArtifactManifestEntry,
        baseUri: string,
        artifactUuid: string,
        testRunUuid?: string
    ): string | null {
        if (entry.storageMode === "file_executed") return null;
        switch (entry.artifactType) {
            case "ontology": return institutionalOntologyGraphUri(baseUri, artifactUuid);
            case "bridge_vocabulary": return entry.sourceFilename === "project-semantic-evidence-v1.ttl"
                ? semanticEvidenceVocabularyGraphUri(baseUri, artifactUuid)
                : projectInstitutionalBridgeGraphUri(baseUri, artifactUuid);
            case "shacl_shapes": return structuralShapesGraphUri(baseUri, artifactUuid);
            case "semantic_policy": return semanticPolicyGraphUri(baseUri, artifactUuid);
            case "institutional_dataset": return institutionalSyntheticDataGraphUri(baseUri, artifactUuid);
            case "test_fixture":
                if (!testRunUuid) throw new SemanticArtifactError("graph_namespace_rejected", "test fixture loading requires a unique testRunUuid");
                return negativeFixtureGraphUri(baseUri, testRunUuid, artifactUuid);
            default:
                throw new SemanticArtifactError("manifest_invalid", `artifact type '${entry.artifactType}' is reserved but not loadable in Prompt 7B1`);
        }
    }

    async registerLoad(input: {
        entry: PublicArtifactManifestEntry;
        integrity: IntegrityValidationSummary;
        baseUri: string;
        idempotencyKey: string;
        activate: boolean;
        testRunUuid?: string;
    }): Promise<RegisteredArtifactOperation> {
        const family = await this.database.ensureFamily({
            familyUuid: this.runtime.newUuid(),
            artifactType: input.entry.artifactType,
            familyKey: familyKey(input.entry),
            name: input.entry.familyName,
            semanticUri: input.entry.semanticUri,
            privacyPolicy: input.entry.privacyClassification,
        });
        // Reuse the immutable identity when this governed semantic version is
        // already registered. Generating a fresh graph URI before
        // ensureArtifact would turn a safe retry after activation into a false
        // metadata conflict.
        const existing = await this.database.findArtifactByFamilyVersion(Number(family.id), input.entry.semanticVersion);
        const proposedUuid = existing?.artifact_uuid ?? this.runtime.newUuid();
        const proposedGraphUri = existing?.named_graph_uri
            ?? this.graphUri(input.entry, input.baseUri, proposedUuid, input.testRunUuid);
        const artifact = await this.database.ensureArtifact({
            artifactUuid: proposedUuid,
            familyId: Number(family.id),
            semanticVersion: input.entry.semanticVersion,
            sourceFilename: input.entry.sourceFilename,
            repositoryRelativePath: input.entry.relativePath,
            byteSize: input.entry.byteSize,
            sha256: input.entry.sha256,
            mediaType: input.entry.mediaType,
            serialization: input.entry.serialization,
            semanticUri: input.entry.semanticUri,
            storageMode: input.entry.storageMode,
            namedGraphUri: proposedGraphUri,
            executorMetadata: null,
            sourcePackageName: input.entry.sourcePackageName,
            sourcePackageVersion: input.entry.sourcePackageVersion,
            sourceReleaseStatus: input.entry.sourceReleaseStatus,
            privacyClassification: input.entry.privacyClassification,
            predecessorArtifactId: existing?.predecessor_artifact_id ??
                (family.current_artifact_id === null ? null : Number(family.current_artifact_id)),
        });
        if (artifact.validation_status === "not_validated") {
            await this.database.markIntegrityValidated(Number(artifact.id), input.integrity);
            artifact.validation_status = "integrity_validated";
        }

        const operationType: ArtifactOperationType = input.activate ? "load_and_activate" : "load_without_activation";
        const operationInput: EnsureLoadOperationInput = {
            operationUuid: this.runtime.newUuid(),
            idempotencyKey: input.idempotencyKey,
            artifactId: Number(artifact.id),
            operationType,
            payloadHash: canonicalOperationHash({
                activate: input.activate,
                artifactKey: input.entry.artifactKey,
                artifactSha256: input.entry.sha256,
                operationType,
            }),
            previousArtifactId: family.current_artifact_id === null ? null : Number(family.current_artifact_id),
        };
        const operation = await this.database.ensureOperation(operationInput);
        return { family, artifact, operation };
    }

    async registerRollback(input: {
        familyKey: string;
        semanticVersion: string;
        idempotencyKey: string;
    }): Promise<RegisteredArtifactOperation> {
        const family = await this.database.findFamilyByKey(input.familyKey);
        if (!family) throw new SemanticArtifactError("artifact_not_found", `family '${input.familyKey}' was not found`);
        const artifact = await this.database.findArtifactByFamilyVersion(Number(family.id), input.semanticVersion);
        if (!artifact) throw new SemanticArtifactError("artifact_not_found", `version '${input.semanticVersion}' was not found in family '${input.familyKey}'`);
        const operation = await this.database.ensureOperation({
            operationUuid: this.runtime.newUuid(),
            idempotencyKey: input.idempotencyKey,
            artifactId: Number(artifact.id),
            operationType: "rollback_activation",
            payloadHash: canonicalOperationHash({
                artifactId: Number(artifact.id),
                familyKey: input.familyKey,
                operationType: "rollback_activation",
                semanticVersion: input.semanticVersion,
            }),
            previousArtifactId: family.current_artifact_id === null ? null : Number(family.current_artifact_id),
        });
        return { family, artifact, operation };
    }
}
