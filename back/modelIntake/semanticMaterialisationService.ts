import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getGraphClient } from "../graph/graphClientProvider.ts";
import { loadGraphConfig } from "../graph/graphConfig.ts";
import { modelVersionGraphUri } from "../graph/namedGraphs.ts";
import type { GraphClient } from "../graph/graphTypes.ts";
import type { ExtractedIfcModel } from "../requirements/modelRequirementsTypes.ts";
import { resolveStorageKey } from "../utils/storage.ts";
import { ModelIntakeDatabase } from "../utils/modelIntakeDatabase.ts";
import { loadModelIntakeConfig } from "./modelIntakeConfig.ts";
import { MappingProfileService } from "./mappingProfileService.ts";
import { buildMinimalRdf } from "./rdfMaterialiser.ts";
import type { IntakeProfile, PreviewAsset, PreviewSpace } from "./modelIntakeTypes.ts";

export interface SemanticMaterialisationDatabasePort {
    getVersionSnapshot(versionId: number): Promise<{ version: any; spaces: any[]; assets: any[] } | null>;
    getMaterialisationByVersion(versionId: number): Promise<any | null>;
    createMaterialisation(input: any): Promise<any>;
    markGraphWritten(id: number, counts: any): Promise<void>;
    markVerified(id: number): Promise<void>;
    markFailed(id: number, code: string, message: string, retryable: boolean): Promise<void>;
}

export interface ActiveMappingResolverPort {
    resolveActive(familyKey: string, artifactRoot: string): Promise<any>;
}

function valueFromPsets(psets: any, property: string): string | null {
    for (const set of Object.values(psets ?? {}) as any[]) {
        const value = set?.[property];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
}

function iri(base: string, suffix: string): string { return `${base.replace(/\/+$/, "")}/${suffix}`; }

export class SemanticMaterialisationService {
    constructor(
        private readonly database: SemanticMaterialisationDatabasePort = new ModelIntakeDatabase(),
        private readonly mappings: ActiveMappingResolverPort = new MappingProfileService(),
        private readonly clientFactory: () => GraphClient = () => getGraphClient(),
        private readonly now: () => Date = () => new Date(),
        private readonly newUuid: () => string = () => crypto.randomUUID(),
    ) {}

    async materialise(input: { versionId: number; extractedModel: ExtractedIfcModel; ids: IntakeProfile }) {
        const config = loadModelIntakeConfig();
        if (!config.materialisationEnabled || config.mode === "disabled") return { status: "disabled" as const };
        const graphConfig = loadGraphConfig();
        if (!graphConfig.configured) throw new Error(graphConfig.reason);
        const mapping = await this.mappings.resolveActive(config.mappingFamilyKey, config.artifactRoot);
        const snapshot = await this.database.getVersionSnapshot(input.versionId);
        if (!snapshot) throw new Error(`Model version ${input.versionId} was not found for semantic materialisation.`);
        const versionUuid = snapshot.version.version_uuid;
        if (!versionUuid) throw new Error("Model version UUID is missing; apply the Prompt 7D migration.");
        const graphUri = modelVersionGraphUri(graphConfig.config.baseUri, versionUuid);
        let record = await this.database.getMaterialisationByVersion(input.versionId);
        const materialisationUuid = record?.materialisation_uuid ?? this.newUuid();
        if (!record) {
            record = await this.database.createMaterialisation({
                materialisationUuid,
                modelVersionId: input.versionId,
                mappingArtifactId: mapping.artifactId,
                idsProfileArtifactId: input.ids.artifactId,
                namedGraphUri: graphUri,
                sourceFileSha256: snapshot.version.file_hash,
                mappingVersion: mapping.version,
            });
        }
        if (record.status === "completed") return this.summary(record, snapshot.version);

        const extractedSpaces = input.extractedModel.inventoryData;
        const spaces: PreviewSpace[] = snapshot.spaces.map((row: any) => {
            const extracted = extractedSpaces[row.ifc_guid] ?? {};
            return {
                persistentUuid: row.space_uuid,
                reference: row.inventory_code,
                label: row.long_name_snapshot ?? row.name_snapshot ?? null,
                ifcGuid: row.ifc_guid,
                ifcClass: "IfcSpace",
                storey: extracted.storeyName ?? null,
                persistentUri: iri(graphConfig.config.baseUri, `space/${row.space_uuid}`),
                manifestationUri: iri(graphConfig.config.baseUri, `model-version/${versionUuid}/manifestation/${encodeURIComponent(row.ifc_guid)}`),
            };
        });
        const assets: PreviewAsset[] = snapshot.assets.map((row: any) => {
            let element: any = null;
            for (const space of Object.values(extractedSpaces) as any[]) {
                element = (space.elements ?? []).find((candidate: any) => candidate.guid === row.ifc_guid);
                if (element) break;
            }
            return {
                persistentUuid: row.asset_uuid,
                tag: row.asset_code,
                serialNumber: row.serial_number ?? valueFromPsets(element?.psets, "SerialNumber"),
                manufacturer: valueFromPsets(element?.psets, "Manufacturer"),
                ifcGuid: row.ifc_guid,
                ifcClass: row.type_snapshot,
                containingSpace: row.space_reference ?? null,
                persistentUri: iri(graphConfig.config.baseUri, `asset/${row.asset_uuid}`),
                manifestationUri: iri(graphConfig.config.baseUri, `model-version/${versionUuid}/manifestation/${encodeURIComponent(row.ifc_guid)}`),
            };
        });
        const rdf = await buildMinimalRdf({
            baseUri: graphConfig.config.baseUri,
            mapping: mapping.profile,
            mappingArtifactUri: iri(graphConfig.config.baseUri, `semantic-artifact/${mapping.artifactUuid}`),
            idsProfileUri: input.ids.source === "governed_active_profile"
                ? iri(graphConfig.config.baseUri, `semantic-artifact/${input.ids.artifactUuid}`)
                : iri(graphConfig.config.baseUri, `temporary-ids-profile/${input.ids.sha256}`),
            idsProfileVersion: input.ids.version,
            runUuid: input.ids.artifactUuid,
            materialisationUuid,
            logicalModelUuid: snapshot.version.model_uuid,
            modelVersionUuid: versionUuid,
            versionNumber: Number(snapshot.version.version_number),
            filename: path.basename(snapshot.version.original_filename),
            fileSha256: snapshot.version.file_hash,
            ifcSchema: input.extractedModel.schema,
            generatedAt: record.started_at ? new Date(record.started_at).toISOString() : this.now().toISOString(),
            spaces,
            assets,
        });

        const client = this.clientFactory();
        const started = Date.now();
        console.log(JSON.stringify({ type: "ifc_rdf_materialisation_started", modelVersionUuid: versionUuid,
            materialisationUuid, mappingProfile: mapping.familyKey, idsProfileSource: input.ids.source, at: this.now().toISOString() }));
        try {
            const exists = await client.query(`ASK { GRAPH <${graphUri}> { ?s ?p ?o } }`);
            if (exists.boolean !== true) await client.putGraph(graphUri, rdf.turtle, "text/turtle");
            await this.database.markGraphWritten(Number(record.id), {
                tripleCount: rdf.tripleCount, spaceCount: rdf.spaceCount, assetCount: rdf.assetCount,
                manifestationCount: rdf.manifestationCount, turtleSha256: rdf.turtleSha256,
            });
            const counted = await client.query<{ count: { type: "literal"; value: string } }>(
                `SELECT (COUNT(*) AS ?count) WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`
            );
            const remoteCount = Number(counted.results?.bindings?.[0]?.count?.value ?? -1);
            if (remoteCount !== rdf.tripleCount) throw new Error(`Remote graph verification count mismatch (${remoteCount} != ${rdf.tripleCount}).`);
            const versionPresent = await client.query(`ASK { GRAPH <${graphUri}> { <${iri(graphConfig.config.baseUri, `model-version/${versionUuid}`)}> ?p ?o } }`);
            if (versionPresent.boolean !== true) throw new Error("Remote graph does not contain the expected model-version resource.");
            const semanticDir = path.dirname(resolveStorageKey(snapshot.version.storage_key));
            const turtlePath = path.join(semanticDir, "model-version.ttl");
            if (fs.existsSync(turtlePath)) {
                const storedHash = crypto.createHash("sha256").update(fs.readFileSync(turtlePath)).digest("hex");
                if (storedHash !== rdf.turtleSha256) throw new Error("Stored immutable Turtle differs from the verified materialisation.");
            } else {
                fs.writeFileSync(turtlePath, rdf.turtle, { encoding: "utf8", flag: "wx" });
            }
            const reportPath = path.join(semanticDir, "semantic-report.json");
            const reportPayload = JSON.stringify({
                modelVersionUuid: versionUuid, namedGraphUri: graphUri, mappingProfile: mapping.familyKey,
                mappingVersion: mapping.version, idsProfileSource: input.ids.source, idsProfileVersion: input.ids.version,
                turtleSha256: rdf.turtleSha256, tripleCount: rdf.tripleCount, spaces, assets,
            }, null, 2);
            if (!fs.existsSync(reportPath)) fs.writeFileSync(reportPath, reportPayload, { encoding: "utf8", flag: "wx" });
            await this.database.markVerified(Number(record.id));
            console.log(JSON.stringify({ type: "model_version_semantic_graph_verified", modelVersionUuid: versionUuid,
                materialisationUuid, tripleCount: rdf.tripleCount, durationMs: Date.now() - started, at: this.now().toISOString() }));
            console.log(JSON.stringify({ type: "ifc_rdf_materialisation_completed", modelVersionUuid: versionUuid,
                materialisationUuid, tripleCount: rdf.tripleCount, spaceCount: rdf.spaceCount, assetCount: rdf.assetCount,
                durationMs: Date.now() - started, at: this.now().toISOString() }));
            return { status: "completed" as const, materialisationUuid, modelVersionUuid: versionUuid,
                namedGraphUri: graphUri, ...rdf };
        } catch (error: any) {
            await this.database.markFailed(Number(record.id), "ifc_rdf_materialisation_failed", String(error?.message ?? error), true);
            console.error(JSON.stringify({ type: "ifc_rdf_materialisation_failed", modelVersionUuid: versionUuid,
                materialisationUuid, errorCode: "ifc_rdf_materialisation_failed", durationMs: Date.now() - started, at: this.now().toISOString() }));
            throw error;
        }
    }

    async summary(recordOrVersionId: any, version?: any) {
        const record = typeof recordOrVersionId === "number" ? await this.database.getMaterialisationByVersion(recordOrVersionId) : recordOrVersionId;
        if (!record) return null;
        return {
            materialisationUuid: record.materialisation_uuid,
            modelVersionUuid: version?.version_uuid ?? null,
            status: record.status,
            namedGraphUri: record.named_graph_uri,
            mappingVersion: record.mapping_version,
            turtleSha256: record.turtle_sha256,
            tripleCount: Number(record.triple_count ?? 0),
            spaceCount: Number(record.space_count ?? 0),
            assetCount: Number(record.asset_count ?? 0),
            manifestationCount: Number(record.manifestation_count ?? 0),
            verifiedAt: record.verified_at,
        };
    }
}
