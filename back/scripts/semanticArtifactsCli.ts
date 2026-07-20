/**
 * Local-only CLI for governed semantic artefacts (Prompt 7B1).
 *
 * There are deliberately no HTTP mutation routes. Startup never invokes this
 * file, and the negative fixture is not loadable through this CLI.
 */
import "dotenv/config";
import crypto from "node:crypto";
import { loadGraphConfig } from "../graph/graphConfig.ts";
import { getGraphClient } from "../graph/graphClientProvider.ts";
import { ArtifactLoaderService } from "../semantic/artifactLoaderService.ts";
import { ArtifactRegistryService } from "../semantic/artifactRegistryService.ts";
import { jsonSemanticArtifactLogger, SemanticArtifactError } from "../semantic/artifactTypes.ts";
import { ArtifactValidationService } from "../semantic/artifactValidation.ts";
import { loadPublicArtifactManifest, FilesystemArtifactSource } from "../semantic/publicArtifactManifest.ts";
import { loadSemanticArtifactConfig } from "../semantic/semanticArtifactConfig.ts";
import { SemanticArtifactDatabase } from "../utils/semanticArtifactDatabase.ts";

function flag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

function option(name: string): string | null {
    const marker = `--${name}`;
    const index = process.argv.indexOf(marker);
    const value = index >= 0 ? process.argv[index + 1] : undefined;
    return typeof value === "string" && !value.startsWith("--") ? value : null;
}

function safePrint(value: unknown): void {
    console.log(JSON.stringify(value, null, 2));
}

async function manifestContext() {
    const config = loadSemanticArtifactConfig();
    const manifest = await loadPublicArtifactManifest(config.manifestPath);
    const source = new FilesystemArtifactSource(config.rootDir);
    const validation = new ArtifactValidationService(source);
    return { config, manifest, source, validation };
}

async function loaderContext() {
    const context = await manifestContext();
    const graph = loadGraphConfig();
    if (!graph.configured) throw new SemanticArtifactError("configuration_error", graph.reason);
    const database = new SemanticArtifactDatabase();
    const registry = new ArtifactRegistryService(database, { newUuid: () => crypto.randomUUID() });
    const loader = new ArtifactLoaderService(
        context.manifest,
        context.validation,
        registry,
        graph.config,
        getGraphClient(),
        jsonSemanticArtifactLogger,
        context.config.loadingEnabled
    );
    return { ...context, database, loader };
}

async function main(): Promise<void> {
    const command = process.argv[2];
    if (!command) throw new SemanticArtifactError("configuration_error", "semantic artifact command is required");

    if (command === "validate") {
        const { manifest, validation } = await manifestContext();
        const results = await validation.validateManifestTree(manifest);
        safePrint({
            ok: true,
            validation: "integrity_validation",
            artifacts: results.map(({ entry, summary }) => ({
                artifactKey: entry.artifactKey,
                sha256: summary.sha256,
                byteSize: summary.byteSize,
                expectedTripleCount: summary.expectedTripleCount,
            })),
            note: "No SHACL execution was performed.",
        });
        return;
    }

    if (command === "status") {
        const database = new SemanticArtifactDatabase();
        const status = await database.statusSnapshot();
        safePrint({
            families: status.families.map((row) => ({
                familyKey: row.family_key,
                artifactType: row.artifact_type,
                currentArtifactId: row.current_artifact_id,
            })),
            artifacts: status.artifacts.map((row) => ({
                artifactUuid: row.artifact_uuid,
                familyId: row.family_id,
                semanticVersion: row.semantic_version,
                lifecycleStatus: row.lifecycle_status,
                validationStatus: row.validation_status,
                namedGraphUri: row.named_graph_uri,
            })),
            operations: status.operations.map((row) => ({
                operationUuid: row.operation_uuid,
                operationType: row.operation_type,
                status: row.status,
                attemptCount: row.attempt_count,
                errorCode: row.error_code,
            })),
        });
        return;
    }

    const dryRun = flag("dry-run");
    if (dryRun && command === "load-public") {
        const { manifest, validation } = await manifestContext();
        const entries = manifest.artifacts.filter((entry) => !entry.testOnly && entry.activationAllowed);
        for (const entry of entries) await validation.validate(entry, true);
        safePrint({ dryRun: true, artifacts: entries.map((entry) => entry.artifactKey), graphWrites: 0, sqlWrites: 0 });
        return;
    }
    if (dryRun && command === "load") {
        const key = option("key");
        if (!key) throw new SemanticArtifactError("configuration_error", "--key is required");
        const { manifest, validation } = await manifestContext();
        const entry = manifest.artifacts.find((candidate) => candidate.artifactKey === key);
        if (!entry || entry.testOnly) throw new SemanticArtifactError("artifact_not_found", "runtime public artifact key was not found");
        await validation.validate(entry, !flag("without-activation"));
        safePrint({ dryRun: true, artifactKey: key, graphWrites: 0, sqlWrites: 0 });
        return;
    }
    if (dryRun && command === "rollback") {
        const familyKey = option("family");
        const semanticVersion = option("to-version");
        if (!familyKey || !semanticVersion) throw new SemanticArtifactError("configuration_error", "--family and --to-version are required");
        safePrint({ dryRun: true, familyKey, semanticVersion, graphDeletes: 0, sqlWrites: 0 });
        return;
    }

    const { loader, manifest } = await loaderContext();
    if (command === "load-public") {
        safePrint(await loader.loadPublic());
        return;
    }
    if (command === "load") {
        const key = option("key");
        if (!key) throw new SemanticArtifactError("configuration_error", "--key is required");
        const entry = manifest.artifacts.find((candidate) => candidate.artifactKey === key);
        if (!entry || entry.testOnly) throw new SemanticArtifactError("artifact_not_found", "runtime public artifact key was not found");
        safePrint(await loader.load({
            artifactKey: key,
            idempotencyKey: option("idempotency-key") ?? `manual-load:${entry.artifactKey}:${entry.sha256}`,
            activate: !flag("without-activation"),
        }));
        return;
    }
    if (command === "retry") {
        const operationUuid = option("operation");
        if (!operationUuid) throw new SemanticArtifactError("configuration_error", "--operation is required");
        safePrint(await loader.retry(operationUuid));
        return;
    }
    if (command === "rollback") {
        const familyKey = option("family");
        const semanticVersion = option("to-version");
        if (!familyKey || !semanticVersion) throw new SemanticArtifactError("configuration_error", "--family and --to-version are required");
        safePrint(await loader.rollback({
            familyKey,
            semanticVersion,
            idempotencyKey: option("idempotency-key") ?? `rollback:${familyKey}:${semanticVersion}`,
        }));
        return;
    }
    throw new SemanticArtifactError("configuration_error", `unknown semantic artifact command '${command}'`);
}

main().catch((error: unknown) => {
    const code = error instanceof SemanticArtifactError ? error.code : "unexpected_error";
    const message = error instanceof Error ? error.message : "Unexpected semantic artifact CLI error";
    console.error(JSON.stringify({ ok: false, code, message: message.slice(0, 1000) }));
    process.exitCode = 1;
});
