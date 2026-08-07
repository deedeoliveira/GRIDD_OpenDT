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
import type { IntakeProfile, PreflightRun, PreviewAsset, PreviewSpace, PreviewSpaceStatus, PreviewSpaceCode } from "./modelIntakeTypes.ts";
import { isValidIfcGlobalId } from "../utils/ifcGlobalId.ts";
import { evaluateIfcSchemaGate } from "../utils/ifcSchemaSupport.ts";
import { deriveSpaceOccurrences } from "../services/spatialPreflightService.ts";
import { loadSemanticValidationConfig } from "../semanticValidation/semanticValidationConfig.ts";

interface UploadedFile { path: string; originalname: string; size: number; }

/**
 * Preview classification for one IfcSpace candidate (ADR-0052). Identity is resolved by
 * GlobalId; the institutional inventory code comes from IfcSpace.Name. Pure function so it
 * is directly unit-testable. Returns a coarse status plus a stable machine-readable code,
 * and a concise operational message — never raw SQL or a stack trace. Codes:
 *  - existing: matched an existing persistent space by GlobalId (inventory code may have
 *    changed → inventoryCodeChanged);
 *  - new: a new GlobalId with no inventory-code conflict;
 *  - invalid_globalid: the GlobalId is missing/malformed (fails ^[0-9A-Za-z_$]{22}$);
 *  - duplicate_candidate_globalid: the same exact GlobalId appears twice in the version;
 *  - missing_space_name: valid GlobalId but no IfcSpace.Name (the required inventory code);
 *  - inventory_code_collision: the candidate inventory code (from Name) is owned by a
 *    DIFFERENT persistent space under uq_spaces_scope_code — whether the candidate GlobalId
 *    is new or an existing space is changing its code.
 */
export function classifyPreviewSpaceIdentity(input: {
    guid: string;
    inventoryCode: string;
    namePresent: boolean;
    duplicateGuid: boolean;
    existingByGlobalId: { id: number; space_uuid: string; inventory_code_normalized: string } | null;
    inventoryCodeOwner: { id: number } | null;
}): { persistentSpaceStatus: PreviewSpaceStatus; blockingCode: PreviewSpaceCode | null; blockingError: string | null; inventoryCodeChanged: boolean; existingInventoryCode: string | null } {
    // full GlobalId validity is the first line of defence, before any status.
    if (!isValidIfcGlobalId(input.guid)) {
        return { persistentSpaceStatus: "invalid", blockingCode: "invalid_globalid",
            blockingError: `IfcSpace GlobalId is missing or malformed (expected exactly 22 characters from 0-9 A-Z a-z _ $).`,
            inventoryCodeChanged: false, existingInventoryCode: null };
    }
    if (input.duplicateGuid) {
        return { persistentSpaceStatus: "invalid", blockingCode: "duplicate_candidate_globalid",
            blockingError: `Duplicate IfcSpace GlobalId '${input.guid}' within this model version.`,
            inventoryCodeChanged: false, existingInventoryCode: null };
    }
    // a valid, non-duplicate GlobalId with a missing/blank IfcSpace.Name is blocking (the
    // Name is the institutionally required inventory code) but the candidate stays visible.
    if (!input.namePresent) {
        return { persistentSpaceStatus: "missing_name", blockingCode: "missing_space_name",
            blockingError: `IfcSpace has a valid GlobalId but no IfcSpace.Name, which is the required institutional inventory code.`,
            inventoryCodeChanged: false, existingInventoryCode: null };
    }
    if (input.existingByGlobalId) {
        // Same persistent space (identity by GlobalId). If the inventory code changed, it
        // must not collide with a DIFFERENT space under uq_spaces_scope_code.
        const existingInventoryCode = input.existingByGlobalId.inventory_code_normalized;
        const inventoryCodeChanged = existingInventoryCode !== input.inventoryCode;
        if (inventoryCodeChanged && input.inventoryCodeOwner && input.inventoryCodeOwner.id !== input.existingByGlobalId.id) {
            return { persistentSpaceStatus: "inventory_code_collision", blockingCode: "inventory_code_collision",
                blockingError: `This space keeps its identity, but its new inventory code '${input.inventoryCode}' (from IfcSpace.Name) is already assigned to a different persistent space (id ${input.inventoryCodeOwner.id}) under the scope uniqueness constraint uq_spaces_scope_code.`,
                inventoryCodeChanged: true, existingInventoryCode };
        }
        return { persistentSpaceStatus: "existing", blockingCode: "existing", blockingError: null, inventoryCodeChanged, existingInventoryCode };
    }
    if (input.inventoryCodeOwner) {
        return { persistentSpaceStatus: "inventory_code_collision", blockingCode: "inventory_code_collision",
            blockingError: `A different persistent space (id ${input.inventoryCodeOwner.id}) already uses inventory code '${input.inventoryCode}' (from IfcSpace.Name). This new GlobalId cannot reuse it under the scope uniqueness constraint uq_spaces_scope_code.`,
            inventoryCodeChanged: false, existingInventoryCode: null };
    }
    return { persistentSpaceStatus: "new", blockingCode: "new", blockingError: null, inventoryCodeChanged: false, existingInventoryCode: null };
}

/**
 * Build the space-preview entries from the LOSSLESS occurrences (ADR-0052). EVERY
 * occurrence yields exactly one PreviewSpace — invalid GlobalIds, Name-less spaces and
 * duplicate GlobalIds included (no silent `continue`). Precedence per candidate:
 * invalid_globalid > duplicate_candidate_globalid > missing_space_name >
 * canonical_schema_missing/canonical_inconsistency > existing/new/inventory_code_collision.
 * A failing schema precondition therefore blocks a candidate that is otherwise valid (and
 * gates its DB identity lookups) but never hides a more fundamental candidate-local error.
 * Exported and dependency-injected so it is directly testable without the heavy preflight
 * pipeline.
 */
export async function buildSpacePreviewEntries(input: {
    occurrences: Array<{ guid: string; name?: string | null; longName?: string | null; entityId?: number | null; storeyName?: string | null; psets?: Record<string, any> | null }>;
    /**
     * LAZY schema precondition: invoked at most ONCE, and ONLY if at least one candidate
     * actually requires database resolution (valid GlobalId, not a duplicate, IfcSpace.Name
     * present). An invalid-only / duplicate-only / Name-less-only set never triggers it, so
     * zero schema queries run when no DB resolution is needed.
     */
    precondition: () => Promise<{ code: "ok" | "canonical_schema_missing" | "canonical_inconsistency"; message: string | null }>;
    baseUri: string;
    runUuid: string;
    storeyOf: (guid: string) => string | null;
    findByGlobalId: (guid: string) => Promise<any | null>;
    findByInventoryCode: (inventoryCode: string) => Promise<any | null>;
}): Promise<PreviewSpace[]> {
    const guidCounts = new Map<string, number>();
    for (const o of input.occurrences) guidCounts.set(o.guid, (guidCounts.get(o.guid) ?? 0) + 1);

    // Precedence: derive candidate-local facts for EVERY occurrence FIRST, with no database
    // access, so an invalid/duplicate/Name-less candidate is classified even when MySQL is
    // unavailable. The inventory code comes from IfcSpace.Name (ADR-0052 §C);
    // Pset_SpaceCommon.Reference is never read. The schema precondition is fetched lazily
    // and only when some candidate truly needs identity resolution.
    const derived = input.occurrences.map((occ) => {
        const nameRaw = occ.name;
        const namePresent = typeof nameRaw === "string" && nameRaw.trim().length > 0;
        return {
            occ,
            validGuid: isValidIfcGlobalId(occ.guid),
            duplicateGuid: guidCounts.get(occ.guid)! > 1,
            namePresent,
            inventoryCode: namePresent ? nameRaw!.trim() : "",
        };
    });
    const anyNeedsResolution = derived.some((d) => d.validGuid && !d.duplicateGuid && d.namePresent);
    // Fetch the precondition at most once, only when a candidate requires DB resolution.
    let preconditionResult: { code: "ok" | "canonical_schema_missing" | "canonical_inconsistency"; message: string | null } | null = null;
    if (anyNeedsResolution) preconditionResult = await input.precondition();

    const out: PreviewSpace[] = [];
    for (const d of derived) {
        const { occ, validGuid, duplicateGuid, namePresent, inventoryCode } = d;
        const guid = occ.guid;
        const name = occ.name ?? null;
        // ADR-0052 §D/§8: IfcSpace.LongName is the explicit optional label field. There is no
        // ambiguous "label" alias; a UI display string is composed from inventoryCode + longName.
        const longName = occ.longName ?? null;
        // Per-occurrence storey: prefer the lossless occurrence's own storey; fall back to
        // the (collapsed) inventory lookup for compatibility.
        const storey = occ.storeyName ?? input.storeyOf(guid);
        const entityId = occ.entityId ?? null;

        let cls: { persistentSpaceStatus: PreviewSpaceStatus; blockingCode: PreviewSpaceCode | null;
            blockingError: string | null; inventoryCodeChanged: boolean; existingInventoryCode: string | null };
        let existing: any = null;

        if (!validGuid || duplicateGuid || !namePresent) {
            // Candidate-local error: classified with NO database access.
            cls = classifyPreviewSpaceIdentity({
                guid, inventoryCode, namePresent, duplicateGuid,
                existingByGlobalId: null, inventoryCodeOwner: null,
            });
        } else if (preconditionResult && preconditionResult.code !== "ok") {
            // Schema/integrity failure: controlled code, no identity lookup.
            cls = { persistentSpaceStatus: "schema_error", blockingCode: preconditionResult.code,
                blockingError: preconditionResult.message, inventoryCodeChanged: false, existingInventoryCode: null };
        } else {
            existing = await input.findByGlobalId(guid);
            const codeChangedForExisting = !!existing && existing.inventory_code_normalized !== inventoryCode;
            const needOwner = !existing || codeChangedForExisting;
            const inventoryCodeOwner = needOwner ? await input.findByInventoryCode(inventoryCode) : null;
            cls = classifyPreviewSpaceIdentity({
                guid, inventoryCode, namePresent, duplicateGuid,
                existingByGlobalId: existing, inventoryCodeOwner,
            });
        }

        // Keep candidate/manifestation URIs DISTINCT even when two occurrences share one
        // GlobalId — the occurrence token is the IFC entity id (descriptive GlobalId
        // retained as a suffix). entityId is never a persistent identity source.
        const occToken = entityId != null ? `occ-${entityId}` : `guid-${encodeURIComponent(guid)}`;
        const persistentUuid = existing?.space_uuid ?? "candidate";
        const persistentUri = existing
            ? `${input.baseUri}/space/${existing.space_uuid}`
            : `${input.baseUri}/candidate/${input.runUuid}/space/${occToken}/${encodeURIComponent(guid)}`;
        out.push({ persistentUuid, inventoryCode,
            ifcGuid: guid, ifcClass: "IfcSpace", storey, persistentUri,
            manifestationUri: `${input.baseUri}/model-version/candidate-${input.runUuid}/manifestation/${occToken}/${encodeURIComponent(guid)}`,
            ifcGlobalId: guid, ifcEntityId: entityId, name, longName,
            persistentSpaceStatus: cls.persistentSpaceStatus, blockingCode: cls.blockingCode,
            existingSpaceId: existing?.id ?? null, existingSpaceUuid: existing?.space_uuid ?? null,
            existingInventoryCode: cls.existingInventoryCode, inventoryCodeChanged: cls.inventoryCodeChanged, blockingError: cls.blockingError });
    }
    return out;
}

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

function safeLatestFailure(value: unknown): { failureStage: string | null; message: string | null } {
    if (typeof value !== "string" || !value.trim()) return { failureStage: null, message: null };
    const compact = value.replace(/[A-Za-z]:[\\/][^\s:]+|\/{1,2}[^\s:]+/g, "[redacted-path]").replace(/\s+/g, " ").trim().slice(0, 500);
    const match = compact.match(/^([a-z][a-z0-9_]{1,80}):\s*(.*)$/i);
    return { failureStage: match?.[1] ?? null, message: (match?.[2] ?? compact) || null };
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
        const models = (await this.database.listModelContexts()).map((row) => {
            const versionCount = Number(row.version_count ?? 0);
            const currentVersion = row.current_version_id == null ? null : {
                id: Number(row.current_version_id), uuid: row.current_version_uuid,
                number: Number(row.current_version_number), ifcHash: row.current_ifc_hash,
            };
            const latestFailure = safeLatestFailure(row.latest_version_failure_reason);
            const latestVersion = row.latest_version_id == null ? null : {
                id: Number(row.latest_version_id), status: row.latest_version_status,
                createdAt: row.latest_version_created_at ?? null,
                failureStage: latestFailure.failureStage, message: latestFailure.message,
            };
            return { ...row, id: Number(row.model_id), uuid: row.model_uuid, name: row.model_name,
                linkedParent: { id: Number(row.linked_model_id), name: row.linked_model_name },
                currentVersion, latestVersion, versionCount,
                state: currentVersion ? "active" : versionCount ? "no_current_version" : "no_active_version",
                canCreateVersion: true };
        });
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
                // ADR-0052 §C/§D: institutional inventory code (IfcSpace.Name) and optional
                // human label (IfcSpace.LongName), version-specific from the binding snapshots.
                // There is NO "reference" alias, and no space.name_snapshot (dropped column).
                inventoryCode: space.inventory_code_snapshot,
                longName: space.long_name_snapshot ?? null,
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
                // Version-accurate containing-space code from the same version's binding
                // snapshot (ADR-0052 §C) — not the mutable current spaces projection.
                containingSpace: asset.space_inventory_code_snapshot ?? null,
                containingSpacePersistentUri: asset.space_uuid
                    ? `${graph.config.baseUri}/space/${asset.space_uuid}` : null,
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
            // IFC4x3-only gate (ADR-0052 §A) — the SINGLE central classifier; runs BEFORE
            // IDS, RDF preview, SHACL, version creation or any persistent identity
            // operation. Node classifies the ACTUAL schema identifier (never the Python
            // schemaSupported flag), so IFC4 and IFC2X3 are rejected here.
            const schemaGate = evaluateIfcSchemaGate(extracted.schema);
            if (!schemaGate.supported) throw new IntakeError(schemaGate.code!, schemaGate.message!, 422);
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
            const linkedModelId = Number(modelContext.linked_model_id);
            // ---- SPACE preview over LOSSLESS occurrences (ADR-0051 §1/§2/§3) ----
            // Iterate one entry per IfcSpace occurrence (never the GlobalId-keyed dict,
            // which has already collapsed duplicates). EVERY candidate is emitted —
            // including invalid GlobalIds and Reference-less spaces — with a stable code.
            // The canonical precondition is passed LAZILY: candidate-local classification
            // runs first, and the schema/integrity DB check is invoked only if a candidate
            // actually needs identity resolution (§2-v3).
            spaces.push(...await buildSpacePreviewEntries({
                occurrences: deriveSpaceOccurrences(extracted),
                precondition: () => this.database.checkCanonicalPreconditionForScope(linkedModelId),
                baseUri: graph.config.baseUri,
                runUuid,
                storeyOf: (guid) => (extracted.inventoryData as any)?.[guid]?.storeyName ?? null,
                findByGlobalId: (guid) => this.database.findSpaceByGlobalId(linkedModelId, guid),
                findByInventoryCode: (code) => this.database.findSpaceByInventoryCode(linkedModelId, code),
            }));

            // ---- ASSET preview (equipment semantics): one pass over the inventory, gated
            // on the CONTAINING SPACE having a valid institutional inventory code. ADR-0052:
            // the space's inventory code is IfcSpace.Name (never Pset_SpaceCommon.Reference);
            // equipment is located by that code. ----
            for (const [guid, space] of Object.entries(extracted.inventoryData) as [string, any][]) {
                const spaceNameRaw = space.spaceName;
                if (typeof spaceNameRaw !== "string" || !spaceNameRaw.trim()) continue;
                const containingCode = spaceNameRaw.trim();
                for (const element of space.elements ?? []) {
                    const classification = getEquipmentClassifier().classify({ guid: element.guid, ifcClass: element.type,
                        name: element.name ?? null, predefinedType: element.predefinedType ?? null, objectType: element.objectType ?? null,
                        tag: element.tag ?? null, psets: element.psets ?? null },
                        { linkedModelId: Number(modelContext.linked_model_id), modelId: input.modelId, modelVersionId: 0 });
                    if (classification.classification !== "managed_equipment" || typeof element.tag !== "string" || !element.tag.trim()) continue;
                    const tag = element.tag.trim().toUpperCase();
                    const current = await this.database.findAssetIdentity(Number(modelContext.linked_model_id), tag);
                    const assetUuid = current?.asset_uuid ?? "candidate";
                    // Locate the equipment by its CONTAINING IfcSpace occurrence (GlobalId
                    // `guid`), never by inventory-code lookup: resolve the persistent/candidate
                    // URI of that occurrence's PreviewSpace (ADR-0052 §F).
                    const containingSpacePersistentUri = spaces.find((s) => s.ifcGuid === guid)?.persistentUri ?? null;
                    assets.push({ persistentUuid: assetUuid, tag,
                        serialNumber: current?.serial_number ?? IfcTagSerialAssetIdentityResolver.extractSerialNumber(element.psets),
                        manufacturer: psetValue(element.psets, "Manufacturer"), ifcGuid: element.guid, ifcClass: element.type,
                        containingSpace: containingCode,
                        containingSpacePersistentUri,
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
        const shaclConfig = loadSemanticValidationConfig();
        if (shaclConfig.mode === "required" && (!previous.shaclValidation?.conforms
            || previous.shaclValidation.shapesSource !== "governed_active_shapes")) {
            throw new IntakeError("governed_shacl_required",
                "Run SHACL with the active governed shapes and obtain conforms=true before creating a model version.", 422);
        }
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
