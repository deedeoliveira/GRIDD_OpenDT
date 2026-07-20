import { GraphError, type GraphClient, type GraphHealthResult, type RdfContentType, type SparqlQueryResult } from "../../graph/graphTypes.ts";
import { SemanticArtifactError, type GraphVerificationSummary, type IntegrityValidationSummary, type SemanticArtifactFamilyRow, type SemanticArtifactLoadOperationRow, type SemanticArtifactRow } from "../../semantic/artifactTypes.ts";
import type { ArtifactSource } from "../../semantic/publicArtifactManifest.ts";
import type {
    EnsureLoadOperationInput,
    EnsureSemanticArtifactInput,
    EnsureSemanticFamilyInput,
    SemanticArtifactDatabasePort,
    SemanticArtifactStatusSnapshot,
} from "../../utils/semanticArtifactDatabase.ts";

export class MemoryArtifactSource implements ArtifactSource {
    readonly rootDir = "memory://semantic-artifacts";

    constructor(readonly files: Map<string, Buffer>) {}

    async read(relativePath: string): Promise<Buffer> {
        const payload = this.files.get(relativePath);
        if (!payload) throw new Error("file not found");
        return Buffer.from(payload);
    }

    async listFiles(): Promise<string[]> {
        return [...this.files.keys()].sort();
    }
}

export class FakeSemanticGraphClient implements GraphClient {
    readonly providerId = "fake-semantic";
    readonly graphs = new Map<string, { payload: string; count: number }>();
    readonly putCalls: Array<{ graphUri: string; payload: string; contentType: RdfContentType }> = [];
    readonly deleteCalls: string[] = [];
    failPut = false;
    failQuery = false;

    constructor(private readonly tripleCountForPayload: (payload: string) => number) {}

    async healthCheck(): Promise<GraphHealthResult> {
        return { ok: true, provider: this.providerId, queryEndpoint: "fake", durationMs: 0, errorCode: null, error: null };
    }

    async putGraph(graphUri: string, rdfPayload: string, contentType: RdfContentType): Promise<void> {
        this.putCalls.push({ graphUri, payload: rdfPayload, contentType });
        if (this.failPut) throw new GraphError("graph_unavailable", "fake Fuseki unavailable", { operation: "putGraph" });
        this.graphs.set(graphUri, { payload: rdfPayload, count: this.tripleCountForPayload(rdfPayload) });
    }

    async query<T = any>(sparql: string): Promise<SparqlQueryResult<T>> {
        if (this.failQuery) throw new GraphError("graph_unavailable", "fake Fuseki query unavailable", { operation: "query" });
        const graphUri = /GRAPH\s+<([^>]+)>/i.exec(sparql)?.[1] ?? "";
        const graph = this.graphs.get(graphUri);
        if (/SELECT\s+\(COUNT/i.test(sparql)) {
            return { results: { bindings: [{ count: { type: "literal", value: String(graph?.count ?? 0) } } as T] } };
        }
        if (/ASK/i.test(sparql)) return { boolean: graph !== undefined };
        return { results: { bindings: [] } };
    }

    async update(): Promise<void> {
        throw new Error("semantic artifact tests do not use SPARQL UPDATE");
    }

    async deleteGraph(graphUri: string): Promise<void> {
        this.deleteCalls.push(graphUri);
        this.graphs.delete(graphUri);
    }
}

export class FakeSemanticArtifactDatabase implements SemanticArtifactDatabasePort {
    readonly families: SemanticArtifactFamilyRow[] = [];
    readonly artifacts: SemanticArtifactRow[] = [];
    readonly operations: SemanticArtifactLoadOperationRow[] = [];
    failMarkGraphVerifiedOnce = false;
    private nextFamilyId = 1;
    private nextArtifactId = 1;
    private nextOperationId = 1;
    private readonly lockTails = new Map<string, Promise<void>>();

    async ensureFamily(input: EnsureSemanticFamilyInput): Promise<SemanticArtifactFamilyRow> {
        const existing = this.families.find((row) => row.family_key === input.familyKey);
        if (existing) {
            if (existing.artifact_type !== input.artifactType || existing.semantic_uri !== input.semanticUri || existing.privacy_policy !== input.privacyPolicy) {
                throw new SemanticArtifactError("artifact_version_conflict", "incompatible family metadata");
            }
            return existing;
        }
        const row: SemanticArtifactFamilyRow = {
            id: this.nextFamilyId++,
            family_uuid: input.familyUuid,
            artifact_type: input.artifactType,
            family_key: input.familyKey,
            name: input.name,
            semantic_uri: input.semanticUri,
            privacy_policy: input.privacyPolicy,
            current_artifact_id: null,
        };
        this.families.push(row);
        return row;
    }

    async ensureArtifact(input: EnsureSemanticArtifactInput): Promise<SemanticArtifactRow> {
        const byVersion = this.artifacts.find((row) => row.family_id === input.familyId && row.semantic_version === input.semanticVersion);
        if (byVersion) {
            if (byVersion.sha256 !== input.sha256 || byVersion.repository_relative_path !== input.repositoryRelativePath) {
                throw new SemanticArtifactError("artifact_version_conflict", "version has a different immutable payload");
            }
            return byVersion;
        }
        const byHash = this.artifacts.find((row) => row.family_id === input.familyId && row.sha256 === input.sha256);
        if (byHash) throw new SemanticArtifactError("artifact_duplicate_content", "family already has this payload hash");
        const row: SemanticArtifactRow = {
            id: this.nextArtifactId++,
            artifact_uuid: input.artifactUuid,
            family_id: input.familyId,
            semantic_version: input.semanticVersion,
            source_filename: input.sourceFilename,
            repository_relative_path: input.repositoryRelativePath,
            byte_size: input.byteSize,
            sha256: input.sha256,
            media_type: input.mediaType,
            serialization: input.serialization,
            semantic_uri: input.semanticUri,
            named_graph_uri: input.namedGraphUri,
            lifecycle_status: "staged",
            validation_status: "not_validated",
            validation_summary_json: null,
            privacy_classification: input.privacyClassification,
            predecessor_artifact_id: input.predecessorArtifactId,
        };
        this.artifacts.push(row);
        return row;
    }

    async ensureOperation(input: EnsureLoadOperationInput): Promise<SemanticArtifactLoadOperationRow> {
        const existing = this.operations.find((row) => row.idempotency_key === input.idempotencyKey);
        if (existing) {
            if (existing.payload_hash !== input.payloadHash || existing.artifact_id !== input.artifactId || existing.operation_type !== input.operationType) {
                throw new SemanticArtifactError("idempotency_conflict", "different payload for idempotency key");
            }
            return existing;
        }
        const row: SemanticArtifactLoadOperationRow = {
            id: this.nextOperationId++,
            operation_uuid: input.operationUuid,
            idempotency_key: input.idempotencyKey,
            artifact_id: input.artifactId,
            operation_type: input.operationType,
            status: "pending_validation",
            payload_hash: input.payloadHash,
            attempt_count: 0,
            previous_artifact_id: input.previousArtifactId,
            error_code: null,
            error_message: null,
        };
        this.operations.push(row);
        return row;
    }

    async findFamilyByKey(familyKey: string): Promise<SemanticArtifactFamilyRow | null> {
        return this.families.find((row) => row.family_key === familyKey) ?? null;
    }

    async findFamilyById(familyId: number): Promise<SemanticArtifactFamilyRow | null> {
        return this.families.find((row) => row.id === familyId) ?? null;
    }

    async findArtifactById(artifactId: number): Promise<SemanticArtifactRow | null> {
        return this.artifacts.find((row) => row.id === artifactId) ?? null;
    }

    async findArtifactByFamilyVersion(familyId: number, semanticVersion: string): Promise<SemanticArtifactRow | null> {
        return this.artifacts.find((row) => row.family_id === familyId && row.semantic_version === semanticVersion) ?? null;
    }

    async findOperationByUuid(operationUuid: string): Promise<SemanticArtifactLoadOperationRow | null> {
        return this.operations.find((row) => row.operation_uuid === operationUuid) ?? null;
    }

    async withOperationLock<T>(operationUuid: string, fn: () => Promise<T>): Promise<T> {
        return this.withLock(`operation:${operationUuid}`, fn);
    }

    private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.lockTails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        this.lockTails.set(key, previous.then(() => gate));
        await previous;
        try {
            return await fn();
        } finally {
            release();
        }
    }

    async incrementOperationAttempt(operationUuid: string): Promise<void> {
        const operation = await this.requiredOperation(operationUuid);
        operation.attempt_count += 1;
    }

    async setOperationStatus(operationUuid: string, status: SemanticArtifactLoadOperationRow["status"], error: { code: string; message: string } | null = null): Promise<void> {
        const operation = await this.requiredOperation(operationUuid);
        operation.status = status;
        operation.error_code = error?.code ?? null;
        operation.error_message = error?.message.slice(0, 1000) ?? null;
    }

    async markIntegrityValidated(artifactId: number, summary: IntegrityValidationSummary): Promise<void> {
        const artifact = this.artifacts.find((row) => row.id === artifactId);
        if (!artifact) throw new Error("artifact not found");
        artifact.validation_status = "integrity_validated";
        artifact.validation_summary_json = { integrity: summary };
    }

    async markGraphVerified(operationUuid: string, artifactId: number, summary: GraphVerificationSummary): Promise<void> {
        if (this.failMarkGraphVerifiedOnce) {
            this.failMarkGraphVerifiedOnce = false;
            throw new Error("fake SQL failed after graph write");
        }
        const artifact = this.artifacts.find((row) => row.id === artifactId);
        if (!artifact) throw new Error("artifact not found");
        artifact.validation_status = "graph_verified";
        artifact.lifecycle_status = "validated";
        artifact.validation_summary_json = summary as unknown as Record<string, unknown>;
        await this.setOperationStatus(operationUuid, "graph_written");
    }

    async completeWithoutActivation(operationUuid: string): Promise<void> {
        await this.setOperationStatus(operationUuid, "completed");
    }

    async activateArtifact(input: { operationUuid: string; familyId: number; artifactId: number; expectedCurrentArtifactId: number | null }): Promise<{ previousArtifactId: number | null; currentArtifactId: number; alreadyCurrent: boolean }> {
        return this.withLock(`family:${input.familyId}`, async () => {
            const family = this.families.find((row) => row.id === input.familyId);
            const artifact = this.artifacts.find((row) => row.id === input.artifactId);
            if (!family || !artifact || artifact.family_id !== family.id) throw new SemanticArtifactError("activation_ineligible", "invalid family target");
            if (artifact.validation_status !== "graph_verified" || artifact.lifecycle_status === "failed" || artifact.lifecycle_status === "retired" || artifact.privacy_classification === "synthetic_test_only") {
                throw new SemanticArtifactError("activation_ineligible", "artifact is not eligible");
            }
            if (family.current_artifact_id === artifact.id) {
                await this.setOperationStatus(input.operationUuid, "completed");
                return { previousArtifactId: artifact.id, currentArtifactId: artifact.id, alreadyCurrent: true };
            }
            if (family.current_artifact_id !== input.expectedCurrentArtifactId) {
                throw new SemanticArtifactError("activation_conflict", "family current changed");
            }
            const previous = family.current_artifact_id;
            if (previous !== null) {
                const old = this.artifacts.find((row) => row.id === previous);
                if (old) old.lifecycle_status = "superseded";
            }
            artifact.lifecycle_status = "active";
            family.current_artifact_id = artifact.id;
            await this.setOperationStatus(input.operationUuid, "completed");
            return { previousArtifactId: previous, currentArtifactId: artifact.id, alreadyCurrent: false };
        });
    }

    async statusSnapshot(): Promise<SemanticArtifactStatusSnapshot> {
        return { families: this.families, artifacts: this.artifacts, operations: this.operations };
    }

    private async requiredOperation(operationUuid: string): Promise<SemanticArtifactLoadOperationRow> {
        const operation = await this.findOperationByUuid(operationUuid);
        if (!operation) throw new Error("operation not found");
        return operation;
    }
}
