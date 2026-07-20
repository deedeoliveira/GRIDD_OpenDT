import MySQLDatabase from "./mysqlDatabase.ts";
import { isDuplicateKeyError } from "./concurrencyControl.ts";
import {
    SemanticArtifactError,
    type ArtifactLifecycleStatus,
    type ArtifactOperationStatus,
    type ArtifactOperationType,
    type GraphVerificationSummary,
    type IntegrityValidationSummary,
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
    namedGraphUri: string;
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

export interface SemanticArtifactDatabasePort {
    ensureFamily(input: EnsureSemanticFamilyInput): Promise<SemanticArtifactFamilyRow>;
    ensureArtifact(input: EnsureSemanticArtifactInput): Promise<SemanticArtifactRow>;
    ensureOperation(input: EnsureLoadOperationInput): Promise<SemanticArtifactLoadOperationRow>;
    findFamilyByKey(familyKey: string): Promise<SemanticArtifactFamilyRow | null>;
    findFamilyById(familyId: number): Promise<SemanticArtifactFamilyRow | null>;
    findArtifactById(artifactId: number): Promise<SemanticArtifactRow | null>;
    findArtifactByFamilyVersion(familyId: number, semanticVersion: string): Promise<SemanticArtifactRow | null>;
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
    completeWithoutActivation(operationUuid: string): Promise<void>;
    activateArtifact(input: {
        operationUuid: string;
        familyId: number;
        artifactId: number;
        expectedCurrentArtifactId: number | null;
    }): Promise<{ previousArtifactId: number | null; currentArtifactId: number; alreadyCurrent: boolean }>;
    statusSnapshot(): Promise<SemanticArtifactStatusSnapshot>;
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
                     serialization, semantic_uri, named_graph_uri, source_package_name,
                     source_package_version, source_release_status, privacy_classification,
                     predecessor_artifact_id)
                VALUES
                    (:artifactUuid, :familyId, :semanticVersion, :sourceFilename,
                     :repositoryRelativePath, :byteSize, :sha256, :mediaType,
                     :serialization, :semanticUri, :namedGraphUri, :sourcePackageName,
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
        return this.db.withNamedLock(`oswadt.semantic_artifact.operation.${operationUuid}`, 30, fn);
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

    async completeWithoutActivation(operationUuid: string): Promise<void> {
        await this.setOperationStatus(operationUuid, "completed", null);
    }

    async activateArtifact(input: {
        operationUuid: string;
        familyId: number;
        artifactId: number;
        expectedCurrentArtifactId: number | null;
    }): Promise<{ previousArtifactId: number | null; currentArtifactId: number; alreadyCurrent: boolean }> {
        return this.db.withTransaction(async (conn) => {
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
            if (artifact.validation_status !== "graph_verified"
                || artifact.lifecycle_status === "failed"
                || artifact.lifecycle_status === "retired"
                || artifact.privacy_classification === "synthetic_test_only"
                || artifact.privacy_classification === "private_local"
                || artifact.privacy_classification === "requires_manual_review") {
                throw new SemanticArtifactError("activation_ineligible", "artifact is not graph-verified and eligible for activation");
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

            if (current !== null) {
                await conn.execute(`
                    UPDATE semantic_artifacts
                    SET lifecycle_status = 'superseded', superseded_at = NOW()
                    WHERE id = :current AND lifecycle_status = 'active'
                `, { current });
            }
            await conn.execute(`
                UPDATE semantic_artifacts
                SET lifecycle_status = 'active', activated_at = NOW(),
                    superseded_at = NULL, retired_at = NULL
                WHERE id = :artifactId
            `, { artifactId: input.artifactId });
            await conn.execute(
                "UPDATE semantic_artifact_families SET current_artifact_id = :artifactId WHERE id = :familyId",
                { artifactId: input.artifactId, familyId: input.familyId }
            );
            await conn.execute(`
                UPDATE semantic_artifact_load_operations
                SET status = 'completed', activated_at = COALESCE(activated_at, NOW()),
                    completed_at = COALESCE(completed_at, NOW()), error_code = NULL, error_message = NULL
                WHERE operation_uuid = :operationUuid
            `, { operationUuid: input.operationUuid });
            return { previousArtifactId: current, currentArtifactId: input.artifactId, alreadyCurrent: false };
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
