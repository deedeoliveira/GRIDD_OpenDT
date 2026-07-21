import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEquipmentClassifier } from "../classification/equipmentClassifierProvider.ts";
import { loadGraphConfig } from "../graph/graphConfig.ts";
import { IfcTagSerialAssetIdentityResolver } from "../identity/ifcTagSerialAssetIdentityResolver.ts";
import { IfcOpenShellIdsValidationProvider } from "../requirements/ifcOpenShellIdsValidationProvider.ts";
import { extractIfcModelFromFile } from "../requirements/ifcFileExtraction.ts";
import { loadIdsValidationConfig } from "../requirements/idsValidationConfig.ts";
import { IdsProfileResolver } from "../requirements/idsProfileResolver.ts";
import { getModelRequirementsValidator } from "../requirements/modelRequirementsProvider.ts";
import { ModelRequirementsValidationService } from "../requirements/modelRequirementsValidationService.ts";
import { handleModelUpload } from "../services/modelUploadService.ts";
import { removeTempFile } from "../utils/storage.ts";
import { ModelIntakeDatabase } from "../utils/modelIntakeDatabase.ts";
import { loadModelIntakeConfig } from "./modelIntakeConfig.ts";
import { getPreflightRun, storePreflightRun } from "./modelIntakeRunStore.ts";
import { MappingProfileService } from "./mappingProfileService.ts";
import { buildMinimalRdf } from "./rdfMaterialiser.ts";
import type { IntakeProfile, PreflightRun, PreviewAsset, PreviewSpace } from "./modelIntakeTypes.ts";

interface UploadedFile { path: string; originalname: string; size: number; }

function sha256(filePath: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertFilename(name: string, extension: string): string {
    if (!name || name !== path.basename(name) || /[\\/\0]/.test(name) || path.extname(name).toLowerCase() !== extension) {
        throw new IntakeError("invalid_upload_name", `A safe ${extension} filename is required.`, 400);
    }
    return name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 200);
}

function assertIfcContent(filePath: string): void {
    const head = fs.readFileSync(filePath).subarray(0, 1024).toString("ascii").toUpperCase();
    if (!head.includes("ISO-10303-21") || !head.includes("FILE_SCHEMA")) {
        throw new IntakeError("invalid_ifc_content", "The uploaded file is not a recognizable IFC STEP file.", 422);
    }
}

function entityCounts(model: any): Record<string, number> {
    const counts: Record<string, number> = { IfcSpace: Object.keys(model.inventoryData ?? {}).length };
    for (const space of Object.values(model.inventoryData ?? {}) as any[]) {
        for (const element of space.elements ?? []) counts[element.type] = (counts[element.type] ?? 0) + 1;
    }
    for (const element of model.uncontainedProxies ?? []) counts[element.type] = (counts[element.type] ?? 0) + 1;
    return counts;
}

function psetValue(psets: any, property: string): string | null {
    for (const pset of Object.values(psets ?? {}) as any[]) {
        const value = pset?.[property];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
}

export class IntakeError extends Error {
    constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message); this.name = "IntakeError"; }
}

export class ModelIntakeService {
    constructor(
        private readonly database = new ModelIntakeDatabase(),
        private readonly idsProvider = new IfcOpenShellIdsValidationProvider(),
        private readonly profiles = new IdsProfileResolver(),
        private readonly mappings = new MappingProfileService(),
    ) {}

    async context() {
        const config = loadModelIntakeConfig();
        if (!config.workspaceEnabled) throw new IntakeError("model_intake_disabled", "The controlled model intake workspace is disabled.", 404);
        const models = await this.database.listModelContexts();
        const ids = await this.resolveProfile("active", undefined, crypto.randomUUID());
        const mapping = await this.mappings.resolveActive(config.mappingFamilyKey, config.artifactRoot);
        return {
            models,
            activeIdsProfile: this.publicProfile(ids),
            mappingProfile: { familyKey: mapping.familyKey, version: mapping.version, sha256: mapping.sha256, status: "active", artifactType: "ifc_rdf_mapping" },
            limits: { maxIfcBytes: config.maxIfcBytes, maxIdsBytes: config.maxIdsBytes },
            modes: { materialisation: config.mode, temporaryIdsUploadEnabled: config.temporaryIdsUploadEnabled },
        };
    }

    async versionResources(versionId: number) {
        const snapshot = await this.database.getVersionSnapshot(versionId);
        if (!snapshot) return null;
        const graph = loadGraphConfig();
        if (!graph.configured) throw new IntakeError("graph_not_configured", graph.reason, 503);
        const versionRoot = `${graph.config.baseUri}/model-version/${snapshot.version.version_uuid}`;
        return {
            spaces: snapshot.spaces.map((space) => ({
                persistentUuid: space.space_uuid,
                reference: space.inventory_code,
                label: space.long_name_snapshot ?? space.name_snapshot ?? null,
                ifcGuid: space.ifc_guid,
                ifcClass: "IfcSpace",
                storey: null,
                persistentUri: `${graph.config.baseUri}/space/${space.space_uuid}`,
                manifestationUri: `${versionRoot}/manifestation/${encodeURIComponent(space.ifc_guid)}`,
            })),
            assets: snapshot.assets.map((asset) => ({
                persistentUuid: asset.asset_uuid,
                tag: asset.asset_code,
                serialNumber: asset.serial_number ?? null,
                ifcGuid: asset.ifc_guid,
                ifcClass: asset.type_snapshot,
                containingSpace: asset.space_reference ?? null,
                persistentUri: `${graph.config.baseUri}/asset/${asset.asset_uuid}`,
                manifestationUri: `${versionRoot}/manifestation/${encodeURIComponent(asset.ifc_guid)}`,
            })),
        };
    }

    async preflight(input: { ifcFile: UploadedFile; idsMode: "active" | "uploaded"; idsFile?: UploadedFile; modelId: number }, store = true): Promise<PreflightRun> {
        const config = loadModelIntakeConfig();
        if (!config.workspaceEnabled) throw new IntakeError("model_intake_disabled", "The controlled model intake workspace is disabled.", 404);
        if (input.ifcFile.size > config.maxIfcBytes) throw new IntakeError("ifc_too_large", "The IFC file exceeds the configured size limit.", 413);
        if (input.idsFile && input.idsFile.size > config.maxIdsBytes) throw new IntakeError("ids_too_large", "The IDS file exceeds the configured size limit.", 413);
        const ifcName = assertFilename(input.ifcFile.originalname, ".ifc");
        if (input.idsMode === "uploaded" && !config.temporaryIdsUploadEnabled) throw new IntakeError("temporary_ids_disabled", "Temporary IDS upload is disabled.", 403);
        if (input.idsMode === "uploaded" && !input.idsFile) throw new IntakeError("ids_file_required", "Select an IDS file for uploaded mode.", 400);
        if (input.idsMode === "active" && input.idsFile) throw new IntakeError("unexpected_ids_file", "Do not send an IDS file when using the active governed profile.", 400);
        const modelContext = await this.database.getModelContext(input.modelId);
        if (!modelContext) throw new IntakeError("model_not_found", "Select an existing logical model line.", 404);
        const runUuid = crypto.randomUUID();
        const started = Date.now();
        console.log(JSON.stringify({ type: "model_intake_preflight_started", correlationId: runUuid, modelId: input.modelId, at: new Date().toISOString() }));
        try {
            assertIfcContent(input.ifcFile.path);
            const ifcHash = sha256(input.ifcFile.path);
            const extracted = await extractIfcModelFromFile(input.ifcFile.path);
            if (!extracted.schema || !extracted.schema.toUpperCase().startsWith("IFC4")) throw new IntakeError("unsupported_ifc_schema", "The controlled mapping currently supports IFC4 only.", 422);
            const profile = await this.resolveProfile(input.idsMode, input.idsFile, runUuid);
            const idsConfig = loadIdsValidationConfig();
            const report = await new ModelRequirementsValidationService(
                { ...idsConfig, enabled: true, mode: "required" }, this.idsProvider,
            ).validate({
                ifcPath: input.ifcFile.path,
                extractedModel: extracted,
                context: { linkedModelId: Number(modelContext.linked_model_id), modelId: input.modelId, modelVersionId: 0 },
                projectValidator: getModelRequirementsValidator(),
                sourceKind: "upload",
                correlationId: runUuid,
                profileOverride: profile,
            });
            const mapping = await this.mappings.resolveActive(config.mappingFamilyKey, config.artifactRoot);
            const graph = loadGraphConfig();
            if (!graph.configured) throw new IntakeError("graph_not_configured", graph.reason, 503);
            const spaces: PreviewSpace[] = [];
            const assets: PreviewAsset[] = [];
            for (const [guid, space] of Object.entries(extracted.inventoryData) as [string, any][]) {
                const referenceRaw = space.psets?.Pset_SpaceCommon?.Reference;
                if (typeof referenceRaw !== "string" || !referenceRaw.trim()) continue;
                const reference = referenceRaw.trim();
                const existing = await this.database.findSpaceIdentity(Number(modelContext.linked_model_id), reference);
                const persistentUuid = existing?.space_uuid ?? "candidate";
                const persistentUri = existing
                    ? `${graph.config.baseUri}/space/${existing.space_uuid}`
                    : `${graph.config.baseUri}/candidate/${runUuid}/space/${encodeURIComponent(reference)}`;
                spaces.push({ persistentUuid, reference, label: space.spaceLongName ?? space.spaceName ?? null,
                    ifcGuid: guid, ifcClass: "IfcSpace", storey: space.storeyName ?? null, persistentUri,
                    manifestationUri: `${graph.config.baseUri}/model-version/candidate-${runUuid}/manifestation/${encodeURIComponent(guid)}` });
                for (const element of space.elements ?? []) {
                    const classification = getEquipmentClassifier().classify({ guid: element.guid, ifcClass: element.type,
                        name: element.name ?? null, predefinedType: element.predefinedType ?? null, objectType: element.objectType ?? null,
                        tag: element.tag ?? null, psets: element.psets ?? null },
                        { linkedModelId: Number(modelContext.linked_model_id), modelId: input.modelId, modelVersionId: 0 });
                    if (classification.classification !== "managed_equipment" || typeof element.tag !== "string" || !element.tag.trim()) continue;
                    const tag = element.tag.trim().toUpperCase();
                    const current = await this.database.findAssetIdentity(Number(modelContext.linked_model_id), tag);
                    const assetUuid = current?.asset_uuid ?? "candidate";
                    assets.push({ persistentUuid: assetUuid, tag,
                        serialNumber: current?.serial_number ?? IfcTagSerialAssetIdentityResolver.extractSerialNumber(element.psets),
                        manufacturer: psetValue(element.psets, "Manufacturer"), ifcGuid: element.guid, ifcClass: element.type,
                        containingSpace: reference,
                        persistentUri: current ? `${graph.config.baseUri}/asset/${current.asset_uuid}` : `${graph.config.baseUri}/candidate/${runUuid}/asset/${encodeURIComponent(tag)}`,
                        manifestationUri: `${graph.config.baseUri}/model-version/candidate-${runUuid}/manifestation/${encodeURIComponent(element.guid)}` });
                }
            }
            const rdfPreview = await buildMinimalRdf({ baseUri: graph.config.baseUri, mapping: mapping.profile,
                mappingArtifactUri: `${graph.config.baseUri}/semantic-artifact/${mapping.artifactUuid}`,
                idsProfileUri: profile.source === "governed_active_profile"
                    ? `${graph.config.baseUri}/semantic-artifact/${profile.artifactUuid}`
                    : `${graph.config.baseUri}/temporary-ids-profile/${profile.sha256}`,
                idsProfileVersion: profile.version, runUuid, materialisationUuid: runUuid,
                logicalModelUuid: modelContext.model_uuid ?? null, modelVersionUuid: null, versionNumber: null,
                filename: ifcName, fileSha256: ifcHash, ifcSchema: extracted.schema, generatedAt: new Date().toISOString(), spaces, assets });
            console.log(JSON.stringify({ type: "ifc_rdf_preview_generated", correlationId: runUuid, fileHash: ifcHash,
                mappingProfile: mapping.familyKey, idsProfileSource: profile.source, tripleCount: rdfPreview.tripleCount,
                spaceCount: spaces.length, assetCount: assets.length, at: new Date().toISOString() }));
            const createdAt = new Date();
            const run: PreflightRun = { runUuid, correlationId: runUuid, createdAt: createdAt.toISOString(),
                expiresAt: new Date(createdAt.getTime() + config.runTtlMs).toISOString(), modelId: input.modelId,
                ifc: { originalFilename: ifcName, serverComputedSha256: ifcHash, byteSize: input.ifcFile.size,
                    detectedIfcSchema: extracted.schema, entityCounts: entityCounts(extracted) },
                ids: this.publicProfile(profile), validation: { overallStatus: report.overallStatus, idsStatus: report.idsStatus,
                    projectRulesStatus: report.projectRulesStatus, blocking: report.blocking, findings: report.findings },
                rdfPreview, extractedModel: extracted };
            if (store) storePreflightRun(run);
            console.log(JSON.stringify({ type: "model_intake_preflight_completed", correlationId: runUuid,
                fileHash: ifcHash, idsHash: profile.sha256, status: report.overallStatus,
                durationMs: Date.now() - started, at: new Date().toISOString() }));
            return run;
        } finally {
            if (store) {
                removeTempFile(input.ifcFile.path);
                if (input.idsFile) removeTempFile(input.idsFile.path);
            }
        }
    }

    async createVersion(input: { preflightRunUuid: string; ifcFile: UploadedFile; idsMode: "active" | "uploaded"; idsFile?: UploadedFile; modelId: number }) {
        const previous = getPreflightRun(input.preflightRunUuid);
        if (!previous) throw new IntakeError("preflight_expired", "Run Validate and preview again before creating a version.", 409);
        if (previous.modelId !== input.modelId) throw new IntakeError("model_context_changed", "The selected model differs from the preflight context.", 409);
        let current: PreflightRun | null = null;
        try {
            current = await this.preflight(input, false);
            if (current.ifc.serverComputedSha256 !== previous.ifc.serverComputedSha256 || current.ids.sha256 !== previous.ids.sha256) {
                throw new IntakeError("input_hash_changed", "The IFC or IDS differs from the reviewed preflight. Validate and preview these inputs first.", 409);
            }
            if (current.validation.blocking) throw new IntakeError("preflight_blocking", "The selected IFC and IDS did not pass the required checks.", 422);
            const absoluteProfile = await this.resolveProfile(input.idsMode, input.idsFile, current.runUuid);
            const result = await handleModelUpload({ tempFilePath: input.ifcFile.path,
                originalFilename: current.ifc.originalFilename, modelId: input.modelId,
                description: `Controlled model intake ${current.runUuid}`, controlledIntake: { idsProfile: absoluteProfile } });
            return { ...result, inputHashes: { ifc: current.ifc.serverComputedSha256, ids: current.ids.sha256 },
                previousCurrentVersion: result.previousCurrentVersionId, newCurrentVersion: result.versionId };
        } finally {
            // handleModelUpload owns IFC cleanup once invoked; this covers all earlier failures.
            if (fs.existsSync(input.ifcFile.path)) removeTempFile(input.ifcFile.path);
            if (input.idsFile && fs.existsSync(input.idsFile.path)) removeTempFile(input.idsFile.path);
        }
    }

    private async resolveProfile(mode: "active" | "uploaded", file: UploadedFile | undefined, correlationId: string): Promise<IntakeProfile> {
        const config = loadModelIntakeConfig();
        const idsConfig = loadIdsValidationConfig();
        let metadata;
        let originalFilename;
        let source: IntakeProfile["source"];
        if (mode === "active") {
            metadata = await this.profiles.resolveActive(idsConfig.familyKey);
            originalFilename = path.basename(metadata.absolutePath);
            source = "governed_active_profile";
        } else {
            if (!file) throw new IntakeError("ids_file_required", "Select an IDS file.", 400);
            originalFilename = assertFilename(file.originalname, ".ids");
            const profileSha256 = sha256(file.path);
            metadata = { artifactId: null, artifactUuid: crypto.randomUUID(), familyKey: "temporary-upload",
                version: "pending-executor", sha256: profileSha256, absolutePath: file.path };
            source = "temporary_uploaded_profile";
            console.log(JSON.stringify({ type: "temporary_ids_profile_received", correlationId, idsHash: profileSha256,
                byteSize: file.size, at: new Date().toISOString() }));
        }
        const checked = await this.idsProvider.validateProfile(metadata, correlationId, idsConfig.timeoutMs);
        if (checked.profileSha256 !== metadata.sha256) throw new IntakeError("ids_hash_mismatch", "The IDS executor hash differs from the received file.", 422);
        return { ...metadata, version: checked.profileVersion, source, originalFilename,
            executorName: checked.executorName, executorVersion: checked.executorVersion,
            specificationCount: checked.specificationCount, requirements: checked.requirements ?? [] };
    }

    private publicProfile(profile: IntakeProfile): Omit<IntakeProfile, "absolutePath"> {
        const { absolutePath: _omitted, ...safe } = profile;
        return safe;
    }
}
