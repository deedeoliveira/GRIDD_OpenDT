import { GraphError } from "../graph/graphTypes.ts";
import { assertOperationalGraphWriteSafety, validateBaseUri, type GraphConfig } from "../graph/graphConfig.ts";
import {
    institutionalOntologyGraphUri,
    institutionalSyntheticDataGraphUri,
    isTestGraphUri,
    projectInstitutionalBridgeGraphUri,
    structuralShapesGraphUri,
    semanticEvidenceVocabularyGraphUri,
    semanticPolicyGraphUri,
} from "../graph/namedGraphs.ts";
import { iri } from "../graph/sparqlText.ts";
import type { SemanticArtifactDatabasePort } from "../utils/semanticArtifactDatabase.ts";
import {
    SemanticArtifactError,
    sanitizeArtifactError,
    type GraphVerificationSummary,
    type PublicArtifactManifest,
    type PublicArtifactManifestEntry,
    type SemanticArtifactFamilyRow,
    type SemanticArtifactLoadOperationRow,
    type SemanticArtifactLogger,
    type SemanticArtifactRow,
    type ValidatedArtifactSource,
} from "./artifactTypes.ts";
import { ArtifactValidationService } from "./artifactValidation.ts";
import { ArtifactRegistryService, type RegisteredArtifactOperation } from "./artifactRegistryService.ts";

export interface LoadArtifactInput {
    artifactKey: string;
    idempotencyKey: string;
    activate?: boolean;
    dryRun?: boolean;
    allowTestFixture?: boolean;
    testRunUuid?: string;
}

export interface ArtifactLoadResult {
    artifactKey: string;
    dryRun: boolean;
    familyId: number | null;
    artifactId: number | null;
    artifactUuid: string | null;
    graphUri: string | null;
    operationUuid: string | null;
    status: string;
    currentArtifactId: number | null;
    graphWritten: boolean;
}

export class ArtifactLoaderService {
    constructor(
        private readonly manifest: PublicArtifactManifest,
        private readonly validation: ArtifactValidationService,
        private readonly registry: ArtifactRegistryService,
        private readonly graphConfig: GraphConfig,
        private readonly graphClient: import("../graph/graphTypes.ts").GraphClient,
        private readonly logger: SemanticArtifactLogger,
        private readonly loadingEnabled: boolean
    ) {}

    private entryByKey(artifactKey: string): PublicArtifactManifestEntry {
        const entry = this.manifest.artifacts.find((candidate) => candidate.artifactKey === artifactKey);
        if (!entry) throw new SemanticArtifactError("artifact_not_found", `public artifact '${artifactKey}' was not found`);
        return entry;
    }

    private entryForArtifact(artifact: SemanticArtifactRow): PublicArtifactManifestEntry {
        const entry = this.manifest.artifacts.find((candidate) => candidate.relativePath === artifact.repository_relative_path);
        if (!entry || entry.sha256 !== artifact.sha256) {
            throw new SemanticArtifactError("artifact_integrity_failed", "registry artifact no longer matches the governed public manifest");
        }
        return entry;
    }

    private assertLoadingEnabled(): void {
        if (!this.loadingEnabled) {
            throw new SemanticArtifactError(
                "loading_disabled",
                "semantic artifact loading is disabled; set SEMANTIC_ARTIFACT_LOADING_ENABLED=true for an explicit local CLI operation"
            );
        }
        assertOperationalGraphWriteSafety(this.graphConfig);
    }

    async validateAll(): Promise<ValidatedArtifactSource[]> {
        return this.validation.validateManifestTree(this.manifest);
    }

    async loadPublic(options: { dryRun?: boolean } = {}): Promise<ArtifactLoadResult[]> {
        const results: ArtifactLoadResult[] = [];
        for (const entry of this.manifest.artifacts.filter((candidate) =>
            candidate.storageMode === "graph_backed" && !candidate.testOnly && candidate.activationAllowed)) {
            results.push(await this.load({
                artifactKey: entry.artifactKey,
                idempotencyKey: `public-load:${entry.artifactKey}:${entry.sha256}`,
                activate: true,
                dryRun: options.dryRun ?? false,
            }));
        }
        return results;
    }

    async load(input: LoadArtifactInput): Promise<ArtifactLoadResult> {
        const entry = this.entryByKey(input.artifactKey);
        if (entry.storageMode !== "graph_backed") {
            throw new SemanticArtifactError("manifest_invalid", "file-executed artifacts use their governed executor setup, not the Fuseki loader");
        }
        const activate = input.activate ?? entry.activationAllowed;
        if (entry.testOnly && !input.allowTestFixture) {
            throw new SemanticArtifactError("artifact_activation_forbidden", "test fixture loading is available only to an isolated test harness");
        }
        const validated = await this.validation.validate(entry, activate);
        if (input.dryRun) {
            return {
                artifactKey: entry.artifactKey,
                dryRun: true,
                familyId: null,
                artifactId: null,
                artifactUuid: null,
                graphUri: null,
                operationUuid: null,
                status: "integrity_validated_dry_run",
                currentArtifactId: null,
                graphWritten: false,
            };
        }
        this.assertLoadingEnabled();

        const registered = await this.registry.registerLoad({
            entry,
            integrity: validated.summary,
            baseUri: this.graphConfig.baseUri,
            idempotencyKey: input.idempotencyKey,
            activate,
            ...(input.testRunUuid !== undefined ? { testRunUuid: input.testRunUuid } : {}),
        });
        return this.executeLoad(registered, validated, activate);
    }

    async retry(operationUuid: string): Promise<ArtifactLoadResult> {
        this.assertLoadingEnabled();
        const operation = await this.registry.db.findOperationByUuid(operationUuid);
        if (!operation) throw new SemanticArtifactError("artifact_not_found", `operation '${operationUuid}' was not found`);
        const artifact = await this.registry.db.findArtifactById(Number(operation.artifact_id));
        if (!artifact) throw new SemanticArtifactError("artifact_not_found", "operation artifact no longer exists");
        const family = await this.registry.db.findFamilyById(Number(artifact.family_id));
        if (!family) throw new SemanticArtifactError("artifact_not_found", "operation family no longer exists");
        if (operation.operation_type === "rollback_activation") {
            return this.executeRollback({ family, artifact, operation });
        }
        if (operation.operation_type !== "load_and_activate" && operation.operation_type !== "load_without_activation") {
            throw new SemanticArtifactError("operation_not_retryable", `operation type '${operation.operation_type}' is not handled by this CLI`);
        }
        const entry = this.entryForArtifact(artifact);
        const validated = await this.validation.validate(entry, operation.operation_type === "load_and_activate");
        return this.executeLoad({ family, artifact, operation }, validated, operation.operation_type === "load_and_activate");
    }

    async rollback(input: { familyKey: string; semanticVersion: string; idempotencyKey: string; dryRun?: boolean }): Promise<ArtifactLoadResult> {
        if (input.dryRun) {
            return {
                artifactKey: `${input.familyKey}@${input.semanticVersion}`,
                dryRun: true,
                familyId: null,
                artifactId: null,
                artifactUuid: null,
                graphUri: null,
                operationUuid: null,
                status: "rollback_dry_run",
                currentArtifactId: null,
                graphWritten: false,
            };
        }
        this.assertLoadingEnabled();
        return this.executeRollback(await this.registry.registerRollback(input));
    }

    async status(): Promise<Awaited<ReturnType<SemanticArtifactDatabasePort["statusSnapshot"]>>> {
        return this.registry.db.statusSnapshot();
    }

    private assertGraphAllowlisted(entry: PublicArtifactManifestEntry, artifact: SemanticArtifactRow): void {
        if (entry.storageMode !== "graph_backed" || artifact.storage_mode !== "graph_backed" || artifact.named_graph_uri === null) {
            throw new SemanticArtifactError("graph_namespace_rejected", "only graph-backed artifacts may be sent to Fuseki");
        }
        const base = validateBaseUri(this.graphConfig.baseUri, "GRAPH_BASE_URI");
        let expected: string | null = null;
        switch (entry.artifactType) {
            case "ontology": expected = institutionalOntologyGraphUri(base, artifact.artifact_uuid); break;
            case "bridge_vocabulary": expected = entry.sourceFilename === "project-semantic-evidence-v1.ttl"
                ? semanticEvidenceVocabularyGraphUri(base, artifact.artifact_uuid)
                : projectInstitutionalBridgeGraphUri(base, artifact.artifact_uuid); break;
            case "shacl_shapes": expected = structuralShapesGraphUri(base, artifact.artifact_uuid); break;
            case "semantic_policy": expected = semanticPolicyGraphUri(base, artifact.artifact_uuid); break;
            case "institutional_dataset": expected = institutionalSyntheticDataGraphUri(base, artifact.artifact_uuid); break;
            case "test_fixture":
                if (!isTestGraphUri(artifact.named_graph_uri)
                    || !artifact.named_graph_uri.endsWith(`/negative/${artifact.artifact_uuid.toLowerCase()}`)) {
                    throw new SemanticArtifactError("graph_namespace_rejected", "negative fixture graph is outside its unique test namespace");
                }
                break;
            default:
                throw new SemanticArtifactError("graph_namespace_rejected", "artifact type has no graph allowlist in this stage");
        }
        if (expected !== null && artifact.named_graph_uri !== expected) {
            throw new SemanticArtifactError("graph_namespace_rejected", "registry graph URI does not match the internally generated artifact namespace");
        }
        if (artifact.named_graph_uri === `${base}/graph/operational` || artifact.named_graph_uri.includes("/graph/operational/")) {
            throw new SemanticArtifactError("graph_namespace_rejected", "semantic artifacts must never use the operational asset graph");
        }
    }

    private async verifyGraph(entry: PublicArtifactManifestEntry, artifact: SemanticArtifactRow): Promise<{ count: number; resourcePresent: boolean | null }> {
        if (artifact.named_graph_uri === null) {
            throw new SemanticArtifactError("graph_namespace_rejected", "file-executed artifacts have no graph verification step");
        }
        const graphIri = iri(artifact.named_graph_uri);
        const countResult = await this.graphClient.query(
            `SELECT (COUNT(*) AS ?count) WHERE { GRAPH ${graphIri} { ?s ?p ?o } }`
        );
        const count = Number(countResult.results?.bindings?.[0]?.count?.value ?? NaN);
        if (count !== entry.tripleCount) {
            throw new SemanticArtifactError(
                "graph_verification_failed",
                `post-load triple count mismatch for '${entry.artifactKey}' (expected ${entry.tripleCount}, got ${Number.isNaN(count) ? "invalid" : count})`
            );
        }
        if (!new Set(["ontology", "bridge_vocabulary", "shacl_shapes", "semantic_policy"]).has(entry.artifactType)) {
            return { count, resourcePresent: null };
        }
        const expected = await this.graphClient.query(`ASK { GRAPH ${graphIri} { ${iri(entry.semanticUri)} ?p ?o } }`);
        if (expected.boolean !== true) {
            throw new SemanticArtifactError("graph_verification_failed", `expected metadata resource is absent for '${entry.artifactKey}'`);
        }
        return { count, resourcePresent: true };
    }

    private async executeLoad(
        registered: RegisteredArtifactOperation,
        validated: ValidatedArtifactSource,
        activate: boolean
    ): Promise<ArtifactLoadResult> {
        const db = this.registry.db;
        return db.withOperationLock(registered.operation.operation_uuid, async () => {
            let operation = await db.findOperationByUuid(registered.operation.operation_uuid) ?? registered.operation;
            let artifact = await db.findArtifactById(Number(registered.artifact.id)) ?? registered.artifact;
            if (operation.status === "completed") {
                return this.result(validated.entry, registered.family, artifact, operation, true);
            }
            if (operation.status === "failed_terminal") {
                throw new SemanticArtifactError("operation_not_retryable", "semantic artifact operation failed terminally and cannot be retried");
            }
            await db.incrementOperationAttempt(operation.operation_uuid);
            this.assertGraphAllowlisted(validated.entry, artifact);

            try {
                if (artifact.validation_status !== "graph_verified") {
                    if (artifact.lifecycle_status === "active") {
                        throw new SemanticArtifactError("activation_ineligible", "an active artifact can never receive another graph PUT");
                    }
                    await db.setOperationStatus(operation.operation_uuid, "pending_graph", null);
                    const graphUri = artifact.named_graph_uri;
                    if (graphUri === null) throw new SemanticArtifactError("graph_namespace_rejected", "graph-backed artifact has no graph URI");
                    await this.graphClient.putGraph(
                        graphUri,
                        validated.payload.toString("utf8"),
                        "text/turtle"
                    );
                    const verified = await this.verifyGraph(validated.entry, artifact);
                    const summary: GraphVerificationSummary = {
                        integrity: validated.summary,
                        fusekiLoading: {
                            kind: "fuseki_parsing_loading_validation",
                            accepted: true,
                            graphUri,
                        },
                        postLoad: {
                            kind: "post_load_graph_verification",
                            tripleCount: verified.count,
                            expectedResourcePresent: verified.resourcePresent,
                        },
                    };
                    await db.markGraphVerified(operation.operation_uuid, Number(artifact.id), summary);
                    artifact = await db.findArtifactById(Number(artifact.id)) ?? { ...artifact, validation_status: "graph_verified", lifecycle_status: "validated" };
                }

                if (activate) {
                    if (!validated.entry.activationAllowed || validated.entry.testOnly) {
                        throw new SemanticArtifactError("artifact_activation_forbidden", "artifact is not allowed to become current");
                    }
                    await db.setOperationStatus(operation.operation_uuid, "pending_activation", null);
                    const activation = await db.activateArtifact({
                        operationUuid: operation.operation_uuid,
                        familyId: Number(registered.family.id),
                        artifactId: Number(artifact.id),
                        expectedCurrentArtifactId: operation.previous_artifact_id === null ? null : Number(operation.previous_artifact_id),
                    });
                    artifact = await db.findArtifactById(Number(artifact.id)) ?? { ...artifact, lifecycle_status: "active" };
                    operation = await db.findOperationByUuid(operation.operation_uuid) ?? { ...operation, status: "completed" };
                    this.logger.info("artifact_activated", {
                        artifactUuid: artifact.artifact_uuid,
                        operationUuid: operation.operation_uuid,
                        previousArtifactId: activation.previousArtifactId,
                    });
                } else {
                    await db.completeWithoutActivation(operation.operation_uuid);
                    operation = await db.findOperationByUuid(operation.operation_uuid) ?? { ...operation, status: "completed" };
                }
                return this.result(validated.entry, registered.family, artifact, operation, true);
            } catch (error) {
                await this.recordFailure(operation.operation_uuid, error);
                throw this.asDomainError(error);
            }
        });
    }

    private async executeRollback(registered: RegisteredArtifactOperation): Promise<ArtifactLoadResult> {
        const db = this.registry.db;
        return db.withOperationLock(registered.operation.operation_uuid, async () => {
            let operation = await db.findOperationByUuid(registered.operation.operation_uuid) ?? registered.operation;
            if (operation.status === "completed") {
                return this.resultFromRows(registered.family, registered.artifact, operation, false);
            }
            if (operation.status === "failed_terminal") {
                throw new SemanticArtifactError("operation_not_retryable", "rollback operation failed terminally and cannot be retried");
            }
            await db.incrementOperationAttempt(operation.operation_uuid);
            try {
                await db.setOperationStatus(operation.operation_uuid, "pending_activation", null);
                await db.activateArtifact({
                    operationUuid: operation.operation_uuid,
                    familyId: Number(registered.family.id),
                    artifactId: Number(registered.artifact.id),
                    expectedCurrentArtifactId: operation.previous_artifact_id === null ? null : Number(operation.previous_artifact_id),
                });
                operation = await db.findOperationByUuid(operation.operation_uuid) ?? { ...operation, status: "completed" };
                this.logger.info("artifact_activation_rolled_back", {
                    artifactUuid: registered.artifact.artifact_uuid,
                    operationUuid: operation.operation_uuid,
                });
                return this.resultFromRows(registered.family, registered.artifact, operation, false);
            } catch (error) {
                await this.recordFailure(operation.operation_uuid, error);
                throw this.asDomainError(error);
            }
        });
    }

    private async recordFailure(operationUuid: string, error: unknown): Promise<void> {
        const domain = this.asDomainError(error);
        const status = domain.retryable ? "failed_retryable" : "failed_terminal";
        const sanitized = sanitizeArtifactError(domain);
        try {
            await this.registry.db.setOperationStatus(operationUuid, status, sanitized);
        } catch {
            // The graph may already be written while SQL is unavailable. The
            // existing operation remains recoverable and retry reuses its URI.
        }
        this.logger.error("artifact_operation_failed", { operationUuid, errorCode: sanitized.code, retryable: domain.retryable });
    }

    private asDomainError(error: unknown): SemanticArtifactError {
        if (error instanceof SemanticArtifactError) return error;
        if (error instanceof GraphError) {
            const terminal = error.code === "graph_authentication_failed"
                || error.code === "graph_configuration_error"
                || (error.code === "graph_update_failed" && error.httpStatus !== null && error.httpStatus >= 400 && error.httpStatus < 500);
            return new SemanticArtifactError(
                "graph_load_failed",
                `semantic artifact graph operation failed: ${error.message}`,
                !terminal,
                { cause: error }
            );
        }
        return new SemanticArtifactError(
            "graph_load_failed",
            "semantic artifact operation failed after registration; retry may resume the same governed operation",
            true,
            { cause: error }
        );
    }

    private result(
        entry: PublicArtifactManifestEntry,
        family: SemanticArtifactFamilyRow,
        artifact: SemanticArtifactRow,
        operation: SemanticArtifactLoadOperationRow,
        graphWritten: boolean
    ): ArtifactLoadResult {
        return {
            artifactKey: entry.artifactKey,
            dryRun: false,
            familyId: Number(family.id),
            artifactId: Number(artifact.id),
            artifactUuid: artifact.artifact_uuid,
            graphUri: artifact.named_graph_uri,
            operationUuid: operation.operation_uuid,
            status: operation.status,
            currentArtifactId: operation.status === "completed" && operation.operation_type !== "load_without_activation" ? Number(artifact.id) : null,
            graphWritten,
        };
    }

    private resultFromRows(
        family: SemanticArtifactFamilyRow,
        artifact: SemanticArtifactRow,
        operation: SemanticArtifactLoadOperationRow,
        graphWritten: boolean
    ): ArtifactLoadResult {
        return {
            artifactKey: `${family.family_key}@${artifact.semantic_version}`,
            dryRun: false,
            familyId: Number(family.id),
            artifactId: Number(artifact.id),
            artifactUuid: artifact.artifact_uuid,
            graphUri: artifact.named_graph_uri,
            operationUuid: operation.operation_uuid,
            status: operation.status,
            currentArtifactId: operation.status === "completed" ? Number(artifact.id) : null,
            graphWritten,
        };
    }
}
