import MySQLDatabase from "./mysqlDatabase.ts";
import { isDuplicateKeyError } from "./concurrencyControl.ts";
import {
    SemanticArtifactError,
    type ArtifactLifecycleStatus,
    type ArtifactOperationStatus,
    type ArtifactOperationType,
    type GraphVerificationSummary,
    type IntegrityValidationSummary,
    type ArtifactStorageMode,
    type ArtifactValidationStatus,
    type PrivacyClassification,
    type SemanticArtifactFamilyRow,
    type SemanticArtifactLoadOperationRow,
    type SemanticArtifactRow,
    type SemanticArtifactType,
} from "../semantic/artifactTypes.ts";

export interface EnsureSemanticFamilyInput {
    familyUuid: string;
    artifactType: SemanticArtifactType;
    familyKey: string;
    name: string;
    semanticUri: string;
    privacyPolicy: PrivacyClassification;
}

export interface EnsureSemanticArtifactInput {
    artifactUuid: string;
    familyId: number;
    semanticVersion: string;
    sourceFilename: string;
    repositoryRelativePath: string;
    byteSize: number;
    sha256: string;
    mediaType: string;
    serialization: string;
    semanticUri: string;
    storageMode: ArtifactStorageMode;
    namedGraphUri: string | null;
    executorMetadata?: Record<string, unknown> | null;
    sourcePackageName: string;
    sourcePackageVersion: string;
    sourceReleaseStatus: string;
    privacyClassification: PrivacyClassification;
    predecessorArtifactId: number | null;
}

export interface EnsureLoadOperationInput {
    operationUuid: string;
    idempotencyKey: string;
    artifactId: number;
    operationType: ArtifactOperationType;
    payloadHash: string;
    previousArtifactId: number | null;
}

export interface SemanticArtifactStatusSnapshot {
    families: SemanticArtifactFamilyRow[];
    artifacts: SemanticArtifactRow[];
    operations: SemanticArtifactLoadOperationRow[];
}

/**
 * One row of a coherent, single-statement snapshot of several families' CURRENT
 * artifact pointers (Change C). `current_artifact_id === null` and every `artifact_*`
 * field being null are BOTH observable states — the join is a LEFT JOIN precisely so
 * that a family with no current pointer (or a dangling one) is visible to the caller
 * instead of silently vanishing. This row type is deliberately free of any IFC4x3
 * compatibility-set semantics: it is a generic multi-family pointer reader.
 */
export interface CurrentArtifactSetRow {
    family_key: string;
    family_id: number;
    artifact_type: SemanticArtifactType;
    current_artifact_id: number | null;
    artifact_id: number | null;
    artifact_uuid: string | null;
    artifact_family_id: number | null;
    semantic_version: string | null;
    sha256: string | null;
    byte_size: number | null;
    repository_relative_path: string | null;
    storage_mode: ArtifactStorageMode | null;
    named_graph_uri: string | null;
    lifecycle_status: ArtifactLifecycleStatus | null;
    validation_status: ArtifactValidationStatus | null;
    privacy_classification: PrivacyClassification | null;
}

export interface SemanticArtifactDatabasePort {
    ensureFamily(input: EnsureSemanticFamilyInput): Promise<SemanticArtifactFamilyRow>;
    ensureArtifact(input: EnsureSemanticArtifactInput): Promise<SemanticArtifactRow>;
    ensureOperation(input: EnsureLoadOperationInput): Promise<SemanticArtifactLoadOperationRow>;
    findFamilyByKey(familyKey: string): Promise<SemanticArtifactFamilyRow | null>;
    findFamilyById(familyId: number): Promise<SemanticArtifactFamilyRow | null>;
    findArtifactById(artifactId: number): Promise<SemanticArtifactRow | null>;
    findArtifactByFamilyVersion(familyId: number, semanticVersion: string): Promise<SemanticArtifactRow | null>;
    resolveCurrentArtifactSet(familyKeys: string[]): Promise<CurrentArtifactSetRow[]>;
    findOperationByUuid(operationUuid: string): Promise<SemanticArtifactLoadOperationRow | null>;
    withOperationLock<T>(operationUuid: string, fn: () => Promise<T>): Promise<T>;
    incrementOperationAttempt(operationUuid: string): Promise<void>;
    setOperationStatus(
        operationUuid: string,
        status: ArtifactOperationStatus,
        error?: { code: string; message: string } | null
    ): Promise<void>;
    markIntegrityValidated(artifactId: number, summary: IntegrityValidationSummary): Promise<void>;
    markGraphVerified(operationUuid: string, artifactId: number, summary: GraphVerificationSummary): Promise<void>;
    markFileVerified(operationUuid: string, artifactId: number, summary: Record<string, unknown>): Promise<void>;
    completeWithoutActivation(operationUuid: string): Promise<void>;
    activateArtifact(input: {
        operationUuid: string;
        familyId: number;
        artifactId: number;
        expectedCurrentArtifactId: number | null;
    }): Promise<{ previousArtifactId: number | null; currentArtifactId: number; alreadyCurrent: boolean }>;
    activateArtifactSet(input: { items: ArtifactSetActivationItem[] }): Promise<ArtifactSetActivationResult>;
    statusSnapshot(): Promise<SemanticArtifactStatusSnapshot>;
}

export interface ArtifactSetActivationItem {
    familyKey: string;
    targetArtifactId: number;
    expectedSourceVersion: string;
    targetVersion: string;
    operationUuid: string;
}

export interface ArtifactSetActivationResult {
    status: "activated" | "already_active";
    results: Array<{
        familyKey: string;
        familyId: number;
        previousArtifactId: number | null;
        currentArtifactId: number;
    }>;
}

function sameNullable(a: unknown, b: unknown): boolean {
    return (a === null || a === undefined) && (b === null || b === undefined)
        ? true
        : String(a) === String(b);
}

export class SemanticArtifactDatabase implements SemanticArtifactDatabasePort {
    private readonly db: MySQLDatabase;

    constructor(db: MySQLDatabase = new MySQLDatabase()) {
        this.db = db;
        void this.db.connect();
    }

    async findFamilyByKey(familyKey: string): Promise<SemanticArtifactFamilyRow | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(
            "SELECT * FROM semantic_artifact_families WHERE family_key = :familyKey LIMIT 1",
            { familyKey }
        );
        return rows[0] ?? null;
    }

    async findFamilyById(familyId: number): Promise<SemanticArtifactFamilyRow | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(
            "SELECT * FROM semantic_artifact_families WHERE id = :familyId LIMIT 1",
            { familyId }
        );
        return rows[0] ?? null;
    }

    async ensureFamily(input: EnsureSemanticFamilyInput): Promise<SemanticArtifactFamilyRow> {
        const existing = await this.findFamilyByKey(input.familyKey);
        if (existing) return this.assertFamilyCompatible(existing, input);

        await this.db.checkConnection();
        try {
            await this.db.connection.execute(`
                INSERT INTO semantic_artifact_families
                    (family_uuid, artifact_type, family_key, name, semantic_uri, privacy_policy)
                VALUES
                    (:familyUuid, :artifactType, :familyKey, :name, :semanticUri, :privacyPolicy)
            `, input);
        } catch (error) {
            if (!isDuplicateKeyError(error)) throw error;
        }
        const converged = await this.findFamilyByKey(input.familyKey);
        if (!converged) throw new Error("semantic artifact family insert did not converge");
        return this.assertFamilyCompatible(converged, input);
    }

    private assertFamilyCompatible(row: SemanticArtifactFamilyRow, input: EnsureSemanticFamilyInput): SemanticArtifactFamilyRow {
        if (row.artifact_type !== input.artifactType || row.semantic_uri !== input.semanticUri || row.privacy_policy !== input.privacyPolicy) {
            throw new SemanticArtifactError("artifact_version_conflict", `family '${input.familyKey}' already exists with incompatible governed metadata`);
        }
        return row;
    }

    async findArtifactById(artifactId: number): Promise<SemanticArtifactRow | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(
            "SELECT * FROM semantic_artifacts WHERE id = :artifactId LIMIT 1",
            { artifactId }
        );
        return rows[0] ?? null;
    }

    async findArtifactByFamilyVersion(familyId: number, semanticVersion: string): Promise<SemanticArtifactRow | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT * FROM semantic_artifacts
            WHERE family_id = :familyId AND semantic_version = :semanticVersion
            LIMIT 1
        `, { familyId, semanticVersion });
        return rows[0] ?? null;
    }

    /**
     * Reads, in EXACTLY ONE SQL statement and with NO explicit transaction and NO
     * `FOR UPDATE`, the current-artifact pointer of every requested family together
     * with the joined artifact row. Under InnoDB's default REPEATABLE READ (and under
     * READ COMMITTED alike) a single statement observes one consistent committed
     * snapshot, so the three governed pointers can never be read half-way through
     * another connection's atomic three-pointer activation transaction.
     *
     * Purely a DB-layer primitive: it knows nothing about IFC4x3 compatibility sets.
     * Missing families simply do not appear in the result — detecting that is the
     * caller's contract. A family whose `current_artifact_id` is NULL (or dangling)
     * still appears, with null artifact columns, thanks to the LEFT JOIN.
     */
    async resolveCurrentArtifactSet(familyKeys: string[]): Promise<CurrentArtifactSetRow[]> {
        if (!Array.isArray(familyKeys) || familyKeys.length === 0) {
            throw new SemanticArtifactError("configuration_error", "resolveCurrentArtifactSet requires at least one family key");
        }
        if (new Set(familyKeys).size !== familyKeys.length) {
            throw new SemanticArtifactError("configuration_error", "resolveCurrentArtifactSet received duplicate family keys");
        }
        await this.db.checkConnection();
        // Named placeholders (mysql2 `namedPlaceholders: true`, as used by every other
        // statement in this file) require one distinct name per IN-list element.
        const names = familyKeys.map((_key, index) => `:familyKey${index}`);
        const params: Record<string, string> = {};
        familyKeys.forEach((key, index) => { params[`familyKey${index}`] = key; });
        const [rows]: any = await this.db.connection.execute(`
            SELECT f.family_key AS family_key,
                   f.id AS family_id,
                   f.artifact_type AS artifact_type,
                   f.current_artifact_id AS current_artifact_id,
                   a.id AS artifact_id,
                   a.artifact_uuid AS artifact_uuid,
                   a.family_id AS artifact_family_id,
                   a.semantic_version AS semantic_version,
                   a.sha256 AS sha256,
                   a.byte_size AS byte_size,
                   a.repository_relative_path AS repository_relative_path,
                   a.storage_mode AS storage_mode,
                   a.named_graph_uri AS named_graph_uri,
                   a.lifecycle_status AS lifecycle_status,
                   a.validation_status AS validation_status,
                   a.privacy_classification AS privacy_classification
            FROM semantic_artifact_families f
            LEFT JOIN semantic_artifacts a ON a.id = f.current_artifact_id
            WHERE f.family_key IN (${names.join(", ")})
        `, params);
        return rows as CurrentArtifactSetRow[];
    }

    private async findArtifactByFamilyHash(familyId: number, sha256: string): Promise<SemanticArtifactRow | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT * FROM semantic_artifacts
            WHERE family_id = :familyId AND sha256 = :sha256
            LIMIT 1
        `, { familyId, sha256 });
        return rows[0] ?? null;
    }

    async ensureArtifact(input: EnsureSemanticArtifactInput): Promise<SemanticArtifactRow> {
        const byVersion = await this.findArtifactByFamilyVersion(input.familyId, input.semanticVersion);
        if (byVersion) return this.assertArtifactCompatible(byVersion, input);

        const byHash = await this.findArtifactByFamilyHash(input.familyId, input.sha256);
        if (byHash) {
            throw new SemanticArtifactError(
                "artifact_duplicate_content",
                `family already contains the same payload hash as semantic version '${byHash.semantic_version}'`
            );
        }

        await this.db.checkConnection();
        try {
            await this.db.connection.execute(`
                INSERT INTO semantic_artifacts
                    (artifact_uuid, family_id, semantic_version, source_filename,
                     repository_relative_path, byte_size, sha256, media_type,
                     serialization, semantic_uri, storage_mode, named_graph_uri, executor_metadata_json, source_package_name,
                     source_package_version, source_release_status, privacy_classification,
                     predecessor_artifact_id)
                VALUES
                    (:artifactUuid, :familyId, :semanticVersion, :sourceFilename,
                     :repositoryRelativePath, :byteSize, :sha256, :mediaType,
                     :serialization, :semanticUri, :storageMode, :namedGraphUri, :executorMetadata, :sourcePackageName,
                     :sourcePackageVersion, :sourceReleaseStatus, :privacyClassification,
                     :predecessorArtifactId)
            `, input);
        } catch (error) {
            if (!isDuplicateKeyError(error)) throw error;
        }
        const converged = await this.findArtifactByFamilyVersion(input.familyId, input.semanticVersion);
        if (!converged) {
            const concurrentHash = await this.findArtifactByFamilyHash(input.familyId, input.sha256);
            if (concurrentHash) {
                throw new SemanticArtifactError(
                    "artifact_duplicate_content",
                    `family already contains the same payload hash as semantic version '${concurrentHash.semantic_version}'`
                );
            }
            throw new SemanticArtifactError(
                "artifact_version_conflict",
                "semantic artifact revision insert conflicted with another immutable identity"
            );
        }
        return this.assertArtifactCompatible(converged, input);
    }

    private assertArtifactCompatible(row: SemanticArtifactRow, input: EnsureSemanticArtifactInput): SemanticArtifactRow {
        const compatible = row.sha256 === input.sha256
            && Number(row.byte_size) === input.byteSize
            && row.repository_relative_path === input.repositoryRelativePath
            && row.semantic_uri === input.semanticUri
            && row.storage_mode === input.storageMode
            && row.named_graph_uri === input.namedGraphUri
            && row.privacy_classification === input.privacyClassification;
        if (!compatible) {
            throw new SemanticArtifactError(
                "artifact_version_conflict",
                `semantic version '${input.semanticVersion}' already exists with a different immutable payload or metadata`
            );
        }
        return row;
    }

    private async findOperationByIdempotencyKey(idempotencyKey: string): Promise<SemanticArtifactLoadOperationRow | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(
            "SELECT * FROM semantic_artifact_load_operations WHERE idempotency_key = :idempotencyKey LIMIT 1",
            { idempotencyKey }
        );
        return rows[0] ?? null;
    }

    async findOperationByUuid(operationUuid: string): Promise<SemanticArtifactLoadOperationRow | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(
            "SELECT * FROM semantic_artifact_load_operations WHERE operation_uuid = :operationUuid LIMIT 1",
            { operationUuid }
        );
        return rows[0] ?? null;
    }

    async ensureOperation(input: EnsureLoadOperationInput): Promise<SemanticArtifactLoadOperationRow> {
        const existing = await this.findOperationByIdempotencyKey(input.idempotencyKey);
        if (existing) return this.assertOperationCompatible(existing, input);

        await this.db.checkConnection();
        try {
            await this.db.connection.execute(`
                INSERT INTO semantic_artifact_load_operations
                    (operation_uuid, idempotency_key, artifact_id, operation_type,
                     payload_hash, previous_artifact_id)
                VALUES
                    (:operationUuid, :idempotencyKey, :artifactId, :operationType,
                     :payloadHash, :previousArtifactId)
            `, input);
        } catch (error) {
            if (!isDuplicateKeyError(error)) throw error;
        }
        const converged = await this.findOperationByIdempotencyKey(input.idempotencyKey);
        if (!converged) throw new Error("semantic artifact operation insert did not converge");
        return this.assertOperationCompatible(converged, input);
    }

    private assertOperationCompatible(row: SemanticArtifactLoadOperationRow, input: EnsureLoadOperationInput): SemanticArtifactLoadOperationRow {
        if (row.payload_hash !== input.payloadHash || Number(row.artifact_id) !== input.artifactId || row.operation_type !== input.operationType) {
            throw new SemanticArtifactError("idempotency_conflict", "idempotency key was already used with a different semantic artifact operation");
        }
        return row;
    }

    async withOperationLock<T>(operationUuid: string, fn: () => Promise<T>): Promise<T> {
        // MySQL user-level lock names are limited to 64 characters. The
        // operation UUID is already unique, so a compact namespace preserves
        // that identity without making the lock invalid on real MySQL 8.
        return this.db.withNamedLock(`oswadt.sem.op.${operationUuid}`, 30, fn);
    }

    async incrementOperationAttempt(operationUuid: string): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`
            UPDATE semantic_artifact_load_operations
            SET attempt_count = attempt_count + 1, started_at = COALESCE(started_at, NOW())
            WHERE operation_uuid = :operationUuid
        `, { operationUuid });
    }

    async setOperationStatus(
        operationUuid: string,
        status: ArtifactOperationStatus,
        error: { code: string; message: string } | null = null
    ): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`
            UPDATE semantic_artifact_load_operations
            SET status = :status,
                error_code = :errorCode,
                error_message = :errorMessage,
                graph_written_at = CASE WHEN :status = 'graph_written' THEN COALESCE(graph_written_at, NOW()) ELSE graph_written_at END,
                activated_at = CASE WHEN :status = 'completed' AND operation_type IN ('load_and_activate','activate_existing','rollback_activation') THEN COALESCE(activated_at, NOW()) ELSE activated_at END,
                completed_at = CASE WHEN :status = 'completed' THEN COALESCE(completed_at, NOW()) ELSE completed_at END
            WHERE operation_uuid = :operationUuid
        `, {
            operationUuid,
            status,
            errorCode: error?.code ?? null,
            errorMessage: error?.message.slice(0, 1000) ?? null,
        });
    }

    async markIntegrityValidated(artifactId: number, summary: IntegrityValidationSummary): Promise<void> {
        await this.db.checkConnection();
        await this.db.connection.execute(`
            UPDATE semantic_artifacts
            SET validation_status = 'integrity_validated',
                validation_summary_json = :summary,
                validated_at = COALESCE(validated_at, NOW())
            WHERE id = :artifactId AND lifecycle_status <> 'failed'
        `, { artifactId, summary: JSON.stringify({ integrity: summary }) });
    }

    async markGraphVerified(operationUuid: string, artifactId: number, summary: GraphVerificationSummary): Promise<void> {
        await this.db.withTransaction(async (conn) => {
            await conn.execute(`
                UPDATE semantic_artifacts
                SET validation_status = 'graph_verified', lifecycle_status = 'validated',
                    validation_summary_json = :summary, validated_at = COALESCE(validated_at, NOW())
                WHERE id = :artifactId AND lifecycle_status NOT IN ('active','retired','failed')
            `, { artifactId, summary: JSON.stringify(summary) });
            await conn.execute(`
                UPDATE semantic_artifact_load_operations
                SET status = 'graph_written', graph_written_at = COALESCE(graph_written_at, NOW()),
                    error_code = NULL, error_message = NULL
                WHERE operation_uuid = :operationUuid
            `, { operationUuid });
        });
    }

    async markFileVerified(operationUuid: string, artifactId: number, summary: Record<string, unknown>): Promise<void> {
        await this.db.withTransaction(async (conn) => {
            await conn.execute(`
                UPDATE semantic_artifacts
                SET validation_status = 'file_verified', lifecycle_status = 'validated',
                    validation_summary_json = :summary, executor_metadata_json = :executorMetadata,
                    validated_at = COALESCE(validated_at, NOW())
                WHERE id = :artifactId AND storage_mode = 'file_executed'
                  AND named_graph_uri IS NULL AND lifecycle_status NOT IN ('active','retired','failed')
            `, {
                artifactId,
                summary: JSON.stringify(summary),
                executorMetadata: JSON.stringify((summary as any).executor ?? {}),
            });
            await conn.execute(`
                UPDATE semantic_artifact_load_operations
                SET status = 'file_validated', error_code = NULL, error_message = NULL
                WHERE operation_uuid = :operationUuid
            `, { operationUuid });
        });
    }

    async completeWithoutActivation(operationUuid: string): Promise<void> {
        await this.setOperationStatus(operationUuid, "completed", null);
    }

    /** True when an artifact's verification/lifecycle/privacy state permits activation. Shared by single and set activation. */
    private isEligibleForActivation(artifact: SemanticArtifactRow): boolean {
        const verifiedForStorage = artifact.storage_mode === "graph_backed"
            ? artifact.validation_status === "graph_verified" && artifact.named_graph_uri !== null
            : artifact.storage_mode === "file_executed"
                && artifact.validation_status === "file_verified" && artifact.named_graph_uri === null;
        return verifiedForStorage
            && artifact.lifecycle_status !== "failed"
            && artifact.lifecycle_status !== "retired"
            && artifact.privacy_classification !== "synthetic_test_only"
            && artifact.privacy_classification !== "private_local"
            && artifact.privacy_classification !== "requires_manual_review";
    }

    /** Supersedes the previous current artifact (if any), activates the target, repoints the family, and completes the operation. Caller must have already performed all eligibility/conflict checks. */
    private async applyActivationMutation(conn: any, params: {
        familyId: number;
        artifactId: number;
        previousArtifactId: number | null;
        operationUuid: string;
    }): Promise<void> {
        if (params.previousArtifactId !== null) {
            await conn.execute(`
                UPDATE semantic_artifacts
                SET lifecycle_status = 'superseded', superseded_at = NOW()
                WHERE id = :previous AND lifecycle_status = 'active'
            `, { previous: params.previousArtifactId });
        }
        await conn.execute(`
            UPDATE semantic_artifacts
            SET lifecycle_status = 'active', activated_at = NOW(),
                superseded_at = NULL, retired_at = NULL
            WHERE id = :artifactId
        `, { artifactId: params.artifactId });
        await conn.execute(
            "UPDATE semantic_artifact_families SET current_artifact_id = :artifactId WHERE id = :familyId",
            { artifactId: params.artifactId, familyId: params.familyId }
        );
        // previous_artifact_id is reconciled HERE, transactionally, to the predecessor
        // actually locked and superseded by THIS mutation — never trusted from whatever
        // value ensureOperation captured before the transaction began (which can be
        // stale on a retry that follows a failed/invalid intermediate attempt).
        await conn.execute(`
            UPDATE semantic_artifact_load_operations
            SET status = 'completed', activated_at = COALESCE(activated_at, NOW()),
                completed_at = COALESCE(completed_at, NOW()), error_code = NULL, error_message = NULL,
                previous_artifact_id = :previousArtifactId
            WHERE operation_uuid = :operationUuid
        `, { operationUuid: params.operationUuid, previousArtifactId: params.previousArtifactId });
    }

    private async activateArtifactCore(conn: any, input: {
        operationUuid: string;
        familyId: number;
        artifactId: number;
        expectedCurrentArtifactId: number | null;
    }): Promise<{ previousArtifactId: number | null; currentArtifactId: number; alreadyCurrent: boolean }> {
        const [familyRows]: any = await conn.execute(
            "SELECT * FROM semantic_artifact_families WHERE id = :familyId LIMIT 1 FOR UPDATE",
            { familyId: input.familyId }
        );
        const family = familyRows[0] as SemanticArtifactFamilyRow | undefined;
        if (!family) throw new SemanticArtifactError("artifact_not_found", "semantic artifact family no longer exists");

        const [artifactRows]: any = await conn.execute(
            "SELECT * FROM semantic_artifacts WHERE id = :artifactId LIMIT 1 FOR UPDATE",
            { artifactId: input.artifactId }
        );
        const artifact = artifactRows[0] as SemanticArtifactRow | undefined;
        if (!artifact || Number(artifact.family_id) !== Number(family.id)) {
            throw new SemanticArtifactError("activation_ineligible", "activation target does not belong to the locked family");
        }
        if (!this.isEligibleForActivation(artifact)) {
            throw new SemanticArtifactError("activation_ineligible", "artifact is not verified for its storage mode and eligible for activation");
        }

        const current = family.current_artifact_id === null ? null : Number(family.current_artifact_id);
        if (current === input.artifactId) {
            await conn.execute(`
                UPDATE semantic_artifact_load_operations
                SET status = 'completed', activated_at = COALESCE(activated_at, NOW()),
                    completed_at = COALESCE(completed_at, NOW()), error_code = NULL, error_message = NULL
                WHERE operation_uuid = :operationUuid
            `, { operationUuid: input.operationUuid });
            return { previousArtifactId: current, currentArtifactId: input.artifactId, alreadyCurrent: true };
        }
        if (!sameNullable(current, input.expectedCurrentArtifactId)) {
            throw new SemanticArtifactError("activation_conflict", "family current pointer changed while this operation was loading");
        }

        await this.applyActivationMutation(conn, {
            familyId: input.familyId,
            artifactId: input.artifactId,
            previousArtifactId: current,
            operationUuid: input.operationUuid,
        });
        return { previousArtifactId: current, currentArtifactId: input.artifactId, alreadyCurrent: false };
    }

    async activateArtifact(input: {
        operationUuid: string;
        familyId: number;
        artifactId: number;
        expectedCurrentArtifactId: number | null;
    }): Promise<{ previousArtifactId: number | null; currentArtifactId: number; alreadyCurrent: boolean }> {
        return this.db.withTransaction((conn) => this.activateArtifactCore(conn, input));
    }

    async activateArtifactSet(input: { items: ArtifactSetActivationItem[] }): Promise<ArtifactSetActivationResult> {
        if (input.items.length === 0) {
            throw new SemanticArtifactError("activation_conflict", "triplet activation requires at least one family target");
        }
        const keys = input.items.map((item) => item.familyKey);
        if (new Set(keys).size !== keys.length) {
            throw new SemanticArtifactError("activation_conflict", "duplicate family key in requested activation set");
        }
        // Deterministic lock order (stable family-key ordering) to minimize deadlock risk
        // against any other caller that also locks these same families in key order.
        const ordered = [...input.items].sort((a, b) => a.familyKey.localeCompare(b.familyKey));

        return this.db.withTransaction(async (conn) => {
            const families: SemanticArtifactFamilyRow[] = [];
            for (const item of ordered) {
                const [rows]: any = await conn.execute(
                    "SELECT * FROM semantic_artifact_families WHERE family_key = :familyKey LIMIT 1 FOR UPDATE",
                    { familyKey: item.familyKey }
                );
                const family = rows[0] as SemanticArtifactFamilyRow | undefined;
                if (!family) throw new SemanticArtifactError("artifact_not_found", `family '${item.familyKey}' was not found`);
                families.push(family);
            }

            if (families.some((family) => family.current_artifact_id === null)) {
                throw new SemanticArtifactError("activation_conflict", "triplet activation requires every family to already have an active current artifact; this operation is not a first-activation/bootstrap path");
            }

            const currentArtifacts: SemanticArtifactRow[] = [];
            for (const family of families) {
                const [rows]: any = await conn.execute(
                    "SELECT * FROM semantic_artifacts WHERE id = :artifactId LIMIT 1 FOR UPDATE",
                    { artifactId: family.current_artifact_id }
                );
                const artifact = rows[0] as SemanticArtifactRow | undefined;
                if (!artifact) throw new SemanticArtifactError("artifact_not_found", "current artifact referenced by a locked family no longer exists");
                currentArtifacts.push(artifact);
            }

            const targetArtifacts: SemanticArtifactRow[] = [];
            for (const item of ordered) {
                const [rows]: any = await conn.execute(
                    "SELECT * FROM semantic_artifacts WHERE id = :artifactId LIMIT 1 FOR UPDATE",
                    { artifactId: item.targetArtifactId }
                );
                const artifact = rows[0] as SemanticArtifactRow | undefined;
                if (!artifact) throw new SemanticArtifactError("artifact_not_found", "target artifact no longer exists");
                targetArtifacts.push(artifact);
            }

            const sourceComplete = ordered.every((item, i) =>
                Number(currentArtifacts[i]!.family_id) === Number(families[i]!.id)
                && currentArtifacts[i]!.semantic_version === item.expectedSourceVersion);
            const targetComplete = ordered.every((item, i) =>
                Number(families[i]!.current_artifact_id) === Number(item.targetArtifactId));

            if (!sourceComplete && !targetComplete) {
                throw new SemanticArtifactError("activation_conflict", "IFC4x3 compatibility triplet is in a mixed/partial state; refusing to auto-converge");
            }

            if (targetComplete) {
                // A complete set of current pointers is NOT, by itself, evidence that THIS
                // governed triplet activation performed the transition (the families could be on
                // target via an unrelated/historical/single-artifact mechanism, or via a STALE
                // operation row left behind by a failed earlier attempt). Require, for every
                // family, transactionally-locked proof that its activate_existing operation
                // already truthfully completed a source->target activation for this exact target
                // artifact — never inferred from current pointers, and never repaired here.
                for (let i = 0; i < ordered.length; i++) {
                    const item = ordered[i]!;
                    const family = families[i]!;

                    const [opRows]: any = await conn.execute(
                        "SELECT * FROM semantic_artifact_load_operations WHERE operation_uuid = :operationUuid LIMIT 1 FOR UPDATE",
                        { operationUuid: item.operationUuid }
                    );
                    const operation = opRows[0] as SemanticArtifactLoadOperationRow | undefined;

                    const [sourceRows]: any = await conn.execute(
                        "SELECT * FROM semantic_artifacts WHERE family_id = :familyId AND semantic_version = :expectedSourceVersion LIMIT 1 FOR UPDATE",
                        { familyId: family.id, expectedSourceVersion: item.expectedSourceVersion }
                    );
                    const expectedSource = sourceRows[0] as SemanticArtifactRow | undefined;

                    const truthful = operation !== undefined
                        && operation.operation_type === "activate_existing"
                        && Number(operation.artifact_id) === Number(item.targetArtifactId)
                        && operation.status === "completed"
                        && expectedSource !== undefined
                        && operation.previous_artifact_id !== null
                        && Number(operation.previous_artifact_id) === Number(expectedSource.id)
                        && Number(operation.previous_artifact_id) !== Number(item.targetArtifactId);

                    if (!truthful) {
                        throw new SemanticArtifactError(
                            "activation_conflict",
                            `family '${item.familyKey}' is on the target revision but has no truthful, already-completed triplet activation evidence for it; refusing to fabricate or repair activation provenance`
                        );
                    }
                }
                return {
                    status: "already_active",
                    results: ordered.map((item, i) => ({
                        familyKey: item.familyKey,
                        familyId: Number(families[i]!.id),
                        previousArtifactId: Number(families[i]!.current_artifact_id),
                        currentArtifactId: item.targetArtifactId,
                    })),
                };
            }

            // sourceComplete === true beyond this point. Verify EVERY target's readiness
            // before performing ANY write — a partial write is never acceptable.
            for (let i = 0; i < ordered.length; i++) {
                const item = ordered[i]!;
                const family = families[i]!;
                const target = targetArtifacts[i]!;
                if (Number(target.family_id) !== Number(family.id) || target.semantic_version !== item.targetVersion) {
                    throw new SemanticArtifactError("activation_ineligible", `target artifact for family '${item.familyKey}' does not match the expected family/version`);
                }
                if (!this.isEligibleForActivation(target)) {
                    throw new SemanticArtifactError("activation_ineligible", `target artifact for family '${item.familyKey}' is not verified for its storage mode and eligible for activation`);
                }
            }

            const results: ArtifactSetActivationResult["results"] = [];
            for (let i = 0; i < ordered.length; i++) {
                const item = ordered[i]!;
                const family = families[i]!;
                const previousArtifactId = Number(family.current_artifact_id);
                await this.applyActivationMutation(conn, {
                    familyId: Number(family.id),
                    artifactId: item.targetArtifactId,
                    previousArtifactId,
                    operationUuid: item.operationUuid,
                });
                results.push({
                    familyKey: item.familyKey,
                    familyId: Number(family.id),
                    previousArtifactId,
                    currentArtifactId: item.targetArtifactId,
                });
            }
            return { status: "activated", results };
        });
    }

    async statusSnapshot(): Promise<SemanticArtifactStatusSnapshot> {
        await this.db.checkConnection();
        const [families]: any = await this.db.connection.execute(
            "SELECT * FROM semantic_artifact_families ORDER BY family_key"
        );
        const [artifacts]: any = await this.db.connection.execute(
            "SELECT * FROM semantic_artifacts ORDER BY family_id, created_at, id"
        );
        const [operations]: any = await this.db.connection.execute(
            "SELECT * FROM semantic_artifact_load_operations ORDER BY created_at, id"
        );
        return { families, artifacts, operations };
    }
}
