import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Parser } from "n3";
import { ArtifactRegistryService } from "../semantic/artifactRegistryService.ts";
import { ArtifactValidationService } from "../semantic/artifactValidation.ts";
import { FilesystemArtifactSource, loadPublicArtifactManifest } from "../semantic/publicArtifactManifest.ts";
import { loadSemanticArtifactConfig } from "../semantic/semanticArtifactConfig.ts";
import { SemanticArtifactDatabase, type SemanticArtifactDatabasePort } from "../utils/semanticArtifactDatabase.ts";
import type { IfcRdfMappingProfile } from "./modelIntakeTypes.ts";

const REQUIRED_NAMESPACES: Record<string, string> = {
    bot: "https://w3id.org/bot#",
    beo: "https://pi.pauwel.be/voc/buildingelement#",
    prov: "http://www.w3.org/ns/prov#",
    dcterms: "http://purl.org/dc/terms/",
    project: "https://deedeoliveira.github.io/GRIDD_OpenDT/ontology/model-intake-v1#",
};
const ALLOWED_CLASSES = new Set(["IfcProject", "IfcBuilding", "IfcBuildingStorey", "IfcSpace", "IfcFurnishingElement", "IfcBuildingElementProxy"]);
const REQUIRED_PATTERNS = ["logicalModel", "modelVersion", "persistentSpace", "persistentAsset", "manifestation", "materialisationActivity", "generatedGraph"];

function stringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim() === "")) {
        throw new Error(`Mapping field '${field}' must be a non-empty string array.`);
    }
    return value as string[];
}

export function validateMappingProfile(value: unknown): IfcRdfMappingProfile {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mapping profile must be a JSON object.");
    const raw = value as Record<string, unknown>;
    if (raw.profileKey !== "oswadt-ifc4-minimal-rdf-mapping" || raw.executionModel !== "declarative_allowlist") {
        throw new Error("Mapping profile identity or execution model is not allowed.");
    }
    if (typeof raw.version !== "string" || !/^\d+\.\d+\.\d+$/.test(raw.version)) throw new Error("Mapping version must be semantic versioning.");
    const namespaces = raw.namespaces as Record<string, unknown>;
    if (!namespaces || Object.keys(namespaces).length !== Object.keys(REQUIRED_NAMESPACES).length
        || Object.entries(REQUIRED_NAMESPACES).some(([key, uri]) => namespaces[key] !== uri)) {
        throw new Error("Mapping namespaces are outside the approved BOT/BEO/PROV/DCT/project allowlist.");
    }
    const classes = stringArray(raw.includedIfcClasses, "includedIfcClasses");
    if (classes.some((name) => !ALLOWED_CLASSES.has(name))) throw new Error("Mapping includes an IFC class outside the minimal allowlist.");
    const patterns = raw.uriPatterns as Record<string, unknown>;
    if (!patterns || REQUIRED_PATTERNS.some((key) => typeof patterns[key] !== "string" || !(patterns[key] as string).startsWith("/"))) {
        throw new Error("Mapping URI patterns are incomplete or external.");
    }
    stringArray(raw.includedProperties, "includedProperties");
    stringArray(raw.predicates, "predicates");
    stringArray(raw.provenanceRules, "provenanceRules");
    const excluded = stringArray(raw.deliberatelyExcluded, "deliberatelyExcluded");
    for (const required of ["geometry", "full ifcOWL", "reservations", "actor links", "institutional data", "SHACL results", "credentials", "filesystem paths"]) {
        if (!excluded.includes(required)) throw new Error(`Mapping must explicitly exclude '${required}'.`);
    }
    return raw as unknown as IfcRdfMappingProfile;
}

export class MappingProfileService {
    constructor(private readonly db: SemanticArtifactDatabasePort = new SemanticArtifactDatabase()) {}

    async validateManifestProfile(familyKey = "oswadt-ifc4-minimal-rdf-mapping") {
        const config = loadSemanticArtifactConfig();
        const manifest = await loadPublicArtifactManifest(config.manifestPath);
        const entry = manifest.artifacts.find((item) => item.artifactType === "ifc_rdf_mapping" && item.artifactKey.startsWith(`${familyKey}-`));
        if (!entry) throw new Error(`Governed mapping family '${familyKey}' is absent from the public manifest.`);
        const validated = await new ArtifactValidationService(new FilesystemArtifactSource(config.rootDir)).validate(entry, true);
        const profile = validateMappingProfile(JSON.parse(validated.payload.toString("utf8")));
        if (profile.version !== entry.semanticVersion) throw new Error("Mapping JSON version differs from its governed manifest version.");
        return { config, entry, validated, profile };
    }

    async registerAndActivate(familyKey = "oswadt-ifc4-minimal-rdf-mapping") {
        const checked = await this.validateManifestProfile(familyKey);
        const registry = new ArtifactRegistryService(this.db);
        const registered = await registry.registerLoad({
            entry: checked.entry,
            integrity: checked.validated.summary,
            baseUri: "http://oswadt.local/id",
            idempotencyKey: `ifc-rdf-mapping:${checked.entry.artifactKey}:activate`,
            activate: true,
        });
        await this.db.markFileVerified(registered.operation.operation_uuid, Number(registered.artifact.id), {
            integrity: checked.validated.summary,
            validation: { kind: "declarative_mapping_schema", accepted: true },
        });
        await this.db.activateArtifact({
            operationUuid: registered.operation.operation_uuid,
            familyId: Number(registered.family.id),
            artifactId: Number(registered.artifact.id),
            expectedCurrentArtifactId: registered.operation.previous_artifact_id === null ? null : Number(registered.operation.previous_artifact_id),
        });
        return { artifactId: Number(registered.artifact.id), artifactUuid: registered.artifact.artifact_uuid, entry: checked.entry, profile: checked.profile };
    }

    async resolveActive(familyKey: string, artifactRoot: string) {
        const family = await this.db.findFamilyByKey(familyKey);
        if (!family || family.artifact_type !== "ifc_rdf_mapping" || family.current_artifact_id === null) throw new Error(`No active governed IFC-to-RDF mapping exists for '${familyKey}'.`);
        const artifact = await this.db.findArtifactById(Number(family.current_artifact_id));
        if (!artifact || artifact.lifecycle_status !== "active" || artifact.validation_status !== "file_verified" || artifact.storage_mode !== "file_executed" || artifact.named_graph_uri !== null) {
            throw new Error("The current IFC-to-RDF mapping is not an active verified file-executed artifact.");
        }
        const absolutePath = path.resolve(artifactRoot, artifact.repository_relative_path);
        const prefix = artifactRoot.endsWith(path.sep) ? artifactRoot : `${artifactRoot}${path.sep}`;
        if (!absolutePath.startsWith(prefix)) throw new Error("The governed mapping path escapes the artifact root.");
        const bytes = fs.readFileSync(absolutePath);
        const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        if (sha256 !== artifact.sha256) throw new Error("Active IFC-to-RDF mapping integrity check failed.");
        const profile = validateMappingProfile(JSON.parse(bytes.toString("utf8")));
        // Load N3 eagerly here so mapping setup fails if the runtime dependency is unavailable.
        void Parser;
        return { artifactId: Number(artifact.id), artifactUuid: artifact.artifact_uuid, sha256, version: artifact.semantic_version, familyKey, profile };
    }
}
