import path from "node:path";
import { promises as fs } from "node:fs";
import {
    ARTIFACT_TYPES,
    PRIVACY_CLASSIFICATIONS,
    SemanticArtifactError,
    type PublicArtifactManifest,
    type PublicArtifactManifestEntry,
} from "./artifactTypes.ts";

export const APPROVED_PUBLIC_SOURCE_FILENAMES = new Set([
    "uminho-institutional-v1.1.ttl",
    "project-institutional-bridge-v1.ttl",
    "uminho-institutional-structural-shapes-v1.1.ttl",
    "uminho-test-data-positive-v1.1.ttl",
    "uminho-test-data-negative-v1.1.ttl",
    "oswadt-ifc4-model-requirements-v1.ids",
    "oswadt-ifc4-minimal-rdf-mapping-v1.json",
]);

const PUBLIC_PRIVACY = new Set(["public_research_artifact", "synthetic_runtime_data", "synthetic_test_only"]);
const SHA256 = /^[0-9a-f]{64}$/;

function requiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new SemanticArtifactError("manifest_invalid", `${field} must be a non-empty string`);
    }
    return value;
}

function parseEntry(value: unknown, index: number): PublicArtifactManifestEntry {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new SemanticArtifactError("manifest_invalid", `artifacts[${index}] must be an object`);
    }
    const raw = value as Record<string, unknown>;
    const artifactType = requiredString(raw.artifactType, `artifacts[${index}].artifactType`);
    const privacy = requiredString(raw.privacyClassification, `artifacts[${index}].privacyClassification`);
    const sourceFilename = requiredString(raw.sourceFilename, `artifacts[${index}].sourceFilename`);
    const relativePath = requiredString(raw.relativePath, `artifacts[${index}].relativePath`);
    const sha256 = requiredString(raw.sha256, `artifacts[${index}].sha256`).toLowerCase();

    if (!ARTIFACT_TYPES.includes(artifactType as never)) {
        throw new SemanticArtifactError("manifest_invalid", `unsupported artifactType '${artifactType}'`);
    }
    if (!PRIVACY_CLASSIFICATIONS.includes(privacy as never) || !PUBLIC_PRIVACY.has(privacy)) {
        throw new SemanticArtifactError("artifact_privacy_rejected", `privacy classification '${privacy}' is forbidden in the public manifest`);
    }
    if (!APPROVED_PUBLIC_SOURCE_FILENAMES.has(sourceFilename)) {
        throw new SemanticArtifactError("manifest_invalid", `source file '${sourceFilename}' is not in the approved public subset`);
    }
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes("..")) {
        throw new SemanticArtifactError("manifest_invalid", `relativePath '${relativePath}' must remain inside semantic/artifacts`);
    }
    if (path.basename(relativePath) !== sourceFilename) {
        throw new SemanticArtifactError("manifest_invalid", `relativePath filename does not match sourceFilename for '${sourceFilename}'`);
    }
    if (!SHA256.test(sha256)) {
        throw new SemanticArtifactError("manifest_invalid", `invalid SHA-256 for '${sourceFilename}'`);
    }
    const storageMode = requiredString(raw.storageMode, `artifacts[${index}].storageMode`);
    const isIds = artifactType === "ids_profile";
    const isMapping = artifactType === "ifc_rdf_mapping";
    if (!new Set(["graph_backed", "file_executed"]).has(storageMode)) {
        throw new SemanticArtifactError("manifest_invalid", `unsupported storageMode '${storageMode}'`);
    }
    if (isIds) {
        if (storageMode !== "file_executed" || raw.mediaType !== "application/ids+xml" || raw.serialization !== "ids-xml") {
            throw new SemanticArtifactError("manifest_invalid", `IDS profile '${sourceFilename}' must be file_executed IDS/XML`);
        }
    } else if (isMapping) {
        if (storageMode !== "file_executed" || raw.mediaType !== "application/json" || raw.serialization !== "json") {
            throw new SemanticArtifactError("manifest_invalid", `IFC-to-RDF mapping '${sourceFilename}' must be file_executed JSON`);
        }
    } else if (storageMode !== "graph_backed" || raw.mediaType !== "text/turtle" || raw.serialization !== "turtle") {
        throw new SemanticArtifactError("manifest_invalid", `RDF artifact '${sourceFilename}' must be graph_backed Turtle`);
    }
    if (!Number.isSafeInteger(raw.byteSize) || Number(raw.byteSize) <= 0
        || ((!isIds && !isMapping) && (!Number.isSafeInteger(raw.tripleCount) || Number(raw.tripleCount) < 0))
        || ((isIds || isMapping) && raw.tripleCount !== 0)) {
        throw new SemanticArtifactError("manifest_invalid", `byteSize/tripleCount are invalid for '${sourceFilename}'`);
    }
    if (typeof raw.activationAllowed !== "boolean" || typeof raw.testOnly !== "boolean") {
        throw new SemanticArtifactError("manifest_invalid", `activationAllowed/testOnly must be boolean for '${sourceFilename}'`);
    }
    if (artifactType === "test_fixture") {
        if (raw.testOnly !== true || raw.activationAllowed !== false || privacy !== "synthetic_test_only") {
            throw new SemanticArtifactError("artifact_activation_forbidden", "test fixtures must be synthetic_test_only, testOnly, and non-activatable");
        }
    } else if (raw.testOnly === true) {
        throw new SemanticArtifactError("manifest_invalid", `only test_fixture may set testOnly=true`);
    }

    return {
        artifactKey: requiredString(raw.artifactKey, `artifacts[${index}].artifactKey`),
        artifactType: artifactType as PublicArtifactManifestEntry["artifactType"],
        familyName: requiredString(raw.familyName, `artifacts[${index}].familyName`),
        semanticVersion: requiredString(raw.semanticVersion, `artifacts[${index}].semanticVersion`),
        sourcePackageName: requiredString(raw.sourcePackageName, `artifacts[${index}].sourcePackageName`),
        sourcePackageVersion: requiredString(raw.sourcePackageVersion, `artifacts[${index}].sourcePackageVersion`),
        sourceReleaseStatus: requiredString(raw.sourceReleaseStatus, `artifacts[${index}].sourceReleaseStatus`),
        sourceFilename,
        relativePath: relativePath.replace(/\\/g, "/"),
        sha256,
        byteSize: Number(raw.byteSize),
        tripleCount: Number(raw.tripleCount),
        mediaType: raw.mediaType as PublicArtifactManifestEntry["mediaType"],
        serialization: raw.serialization as PublicArtifactManifestEntry["serialization"],
        storageMode: storageMode as PublicArtifactManifestEntry["storageMode"],
        semanticUri: requiredString(raw.semanticUri, `artifacts[${index}].semanticUri`),
        privacyClassification: privacy as PublicArtifactManifestEntry["privacyClassification"],
        activationAllowed: raw.activationAllowed,
        testOnly: raw.testOnly,
    };
}

export function parsePublicArtifactManifest(input: string | unknown): PublicArtifactManifest {
    let raw: unknown;
    try {
        raw = typeof input === "string" ? JSON.parse(input) : input;
    } catch (error) {
        throw new SemanticArtifactError("manifest_invalid", "public semantic artifact manifest is not valid JSON", false, { cause: error });
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new SemanticArtifactError("manifest_invalid", "public semantic artifact manifest must be an object");
    }
    const object = raw as Record<string, unknown>;
    if (!Array.isArray(object.artifacts)) {
        throw new SemanticArtifactError("manifest_invalid", "manifest.artifacts must be an array");
    }
    const artifacts = object.artifacts.map(parseEntry);
    const keys = new Set<string>();
    const paths = new Set<string>();
    for (const entry of artifacts) {
        if (keys.has(entry.artifactKey)) throw new SemanticArtifactError("manifest_invalid", `duplicate artifactKey '${entry.artifactKey}'`);
        if (paths.has(entry.relativePath)) throw new SemanticArtifactError("manifest_invalid", `duplicate relativePath '${entry.relativePath}'`);
        keys.add(entry.artifactKey);
        paths.add(entry.relativePath);
    }
    return {
        manifestVersion: requiredString(object.manifestVersion, "manifestVersion"),
        sourcePackageName: requiredString(object.sourcePackageName, "sourcePackageName"),
        sourcePackageVersion: requiredString(object.sourcePackageVersion, "sourcePackageVersion"),
        sourceReleaseStatus: requiredString(object.sourceReleaseStatus, "sourceReleaseStatus"),
        artifacts,
    };
}

export async function loadPublicArtifactManifest(manifestPath: string): Promise<PublicArtifactManifest> {
    return parsePublicArtifactManifest(await fs.readFile(manifestPath, "utf8"));
}

export interface ArtifactSource {
    readonly rootDir: string;
    read(relativePath: string): Promise<Buffer>;
    listFiles(): Promise<string[]>;
}

export class FilesystemArtifactSource implements ArtifactSource {
    readonly rootDir: string;

    constructor(rootDir: string) {
        this.rootDir = path.resolve(rootDir);
    }

    private candidate(relativePath: string): string {
        if (path.isAbsolute(relativePath)) {
            throw new SemanticArtifactError("manifest_invalid", "artifact path must be relative");
        }
        const candidate = path.resolve(this.rootDir, relativePath);
        const prefix = this.rootDir.endsWith(path.sep) ? this.rootDir : `${this.rootDir}${path.sep}`;
        if (!candidate.startsWith(prefix)) {
            throw new SemanticArtifactError("manifest_invalid", `artifact path escapes semantic root: '${relativePath}'`);
        }
        return candidate;
    }

    async read(relativePath: string): Promise<Buffer> {
        const rootReal = await fs.realpath(this.rootDir);
        const candidateReal = await fs.realpath(this.candidate(relativePath));
        const prefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
        if (!candidateReal.startsWith(prefix)) {
            throw new SemanticArtifactError("manifest_invalid", `artifact symlink escapes semantic root: '${relativePath}'`);
        }
        return fs.readFile(candidateReal);
    }

    async listFiles(): Promise<string[]> {
        const files: string[] = [];
        const visit = async (dir: string): Promise<void> => {
            for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) await visit(full);
                else if (entry.isFile()) files.push(path.relative(this.rootDir, full).replace(/\\/g, "/"));
            }
        };
        await visit(this.rootDir);
        return files.sort();
    }
}
