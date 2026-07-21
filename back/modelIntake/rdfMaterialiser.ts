import crypto from "node:crypto";
import { DataFactory, Parser, Writer, type Quad } from "n3";
import type { IfcRdfMappingProfile, PreviewAsset, PreviewSpace, RdfPreview } from "./modelIntakeTypes.ts";

const { namedNode, literal, quad } = DataFactory;
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XSD = "http://www.w3.org/2001/XMLSchema#";

export interface RdfBuildInput {
    baseUri: string;
    mapping: IfcRdfMappingProfile;
    mappingArtifactUri: string;
    idsProfileUri: string;
    idsProfileVersion: string;
    runUuid: string;
    materialisationUuid: string;
    logicalModelUuid: string | null;
    modelVersionUuid: string | null;
    versionNumber: number | null;
    filename: string;
    fileSha256: string;
    ifcSchema: string | null;
    generatedAt: string;
    spaces: PreviewSpace[];
    assets: PreviewAsset[];
}

function safeBase(value: string): string { return value.replace(/\/+$/, ""); }
function uri(base: string, path: string): string { return `${safeBase(base)}${path}`; }

async function serialize(quads: Quad[], prefixes: Record<string, string>): Promise<string> {
    const writer = new Writer({ prefixes });
    writer.addQuads(quads);
    return new Promise((resolve, reject) => writer.end((error, result) => error ? reject(error) : resolve(result)));
}

export async function buildMinimalRdf(input: RdfBuildInput): Promise<RdfPreview> {
    const p = input.mapping.namespaces.project;
    const prov = input.mapping.namespaces.prov;
    const dct = input.mapping.namespaces.dcterms;
    const bot = input.mapping.namespaces.bot;
    const beo = input.mapping.namespaces.beo;
    const versionKey = input.modelVersionUuid ?? `candidate-${input.runUuid}`;
    const modelKey = input.logicalModelUuid ?? `candidate-${input.runUuid}`;
    const modelUri = uri(input.baseUri, `/model/${encodeURIComponent(modelKey)}`);
    const versionUri = uri(input.baseUri, `/model-version/${encodeURIComponent(versionKey)}`);
    const activityUri = uri(input.baseUri, `/activity/ifc-rdf-materialisation/${encodeURIComponent(input.materialisationUuid)}`);
    const sourceUri = uri(input.baseUri, `/source/ifc/${input.fileSha256}`);
    const graphUri = uri(input.baseUri, `/graph/model-version/${encodeURIComponent(versionKey)}`);
    const quads: Quad[] = [];
    const addType = (subject: string, object: string) => quads.push(quad(namedNode(subject), namedNode(`${RDF}type`), namedNode(object)));
    const addIri = (subject: string, predicate: string, object: string) => quads.push(quad(namedNode(subject), namedNode(predicate), namedNode(object)));
    const addLiteral = (subject: string, predicate: string, value: string, datatype?: string) => quads.push(quad(namedNode(subject), namedNode(predicate), datatype ? literal(value, namedNode(datatype)) : literal(value)));

    addType(modelUri, `${p}LogicalModel`);
    addType(versionUri, `${p}ModelVersion`);
    addType(sourceUri, `${prov}Entity`);
    addType(activityUri, `${prov}Activity`);
    addType(graphUri, `${prov}Entity`);
    addIri(modelUri, `${dct}hasVersion`, versionUri);
    addIri(versionUri, `${prov}wasGeneratedBy`, activityUri);
    addIri(activityUri, `${prov}used`, sourceUri);
    addIri(activityUri, `${prov}used`, input.mappingArtifactUri);
    addIri(activityUri, `${prov}used`, input.idsProfileUri);
    addIri(activityUri, `${prov}generated`, graphUri);
    addLiteral(sourceUri, `${dct}title`, input.filename);
    addLiteral(sourceUri, `${p}fileSha256`, input.fileSha256);
    addLiteral(versionUri, `${p}versionUuid`, input.modelVersionUuid ?? "candidate");
    if (input.versionNumber !== null) addLiteral(versionUri, `${p}versionNumber`, String(input.versionNumber), `${XSD}integer`);
    if (input.ifcSchema) addLiteral(versionUri, `${p}ifcSchema`, input.ifcSchema);
    addLiteral(activityUri, `${p}mappingProfileVersion`, input.mapping.version);
    addLiteral(activityUri, `${p}idsProfileVersion`, input.idsProfileVersion);
    addLiteral(activityUri, `${prov}startedAtTime`, input.generatedAt, `${XSD}dateTime`);

    for (const space of input.spaces) {
        addType(space.persistentUri, `${bot}Space`);
        addLiteral(space.persistentUri, `${p}persistentUuid`, space.persistentUuid);
        addLiteral(space.persistentUri, `${p}reference`, space.reference);
        if (space.label) addLiteral(space.persistentUri, `${dct}title`, space.label);
        addType(space.manifestationUri, `${p}IfcManifestation`);
        addIri(space.manifestationUri, `${prov}specializationOf`, space.persistentUri);
        addIri(space.manifestationUri, `${p}modelVersion`, versionUri);
        addLiteral(space.manifestationUri, `${p}ifcClass`, space.ifcClass);
        addLiteral(space.manifestationUri, `${p}ifcGuid`, space.ifcGuid);
        if (space.storey) addLiteral(space.manifestationUri, `${p}storeyLabel`, space.storey);
    }
    for (const asset of input.assets) {
        addType(asset.persistentUri, `${beo}Furnishing`);
        addLiteral(asset.persistentUri, `${p}persistentUuid`, asset.persistentUuid);
        addLiteral(asset.persistentUri, `${p}tag`, asset.tag);
        if (asset.serialNumber) addLiteral(asset.persistentUri, `${p}serialNumber`, asset.serialNumber);
        if (asset.manufacturer) addLiteral(asset.persistentUri, `${p}manufacturer`, asset.manufacturer);
        addType(asset.manifestationUri, `${p}IfcManifestation`);
        addIri(asset.manifestationUri, `${prov}specializationOf`, asset.persistentUri);
        addIri(asset.manifestationUri, `${p}modelVersion`, versionUri);
        addLiteral(asset.manifestationUri, `${p}ifcClass`, asset.ifcClass);
        addLiteral(asset.manifestationUri, `${p}ifcGuid`, asset.ifcGuid);
        const space = input.spaces.find((item) => item.reference === asset.containingSpace);
        if (space) addIri(asset.manifestationUri, `${p}containedInSpace`, space.persistentUri);
    }

    const turtle = await serialize(quads, input.mapping.namespaces);
    const parsed = new Parser().parse(turtle);
    if (parsed.length !== quads.length) throw new Error("Generated Turtle failed local round-trip verification.");
    const turtleSha256 = crypto.createHash("sha256").update(turtle).digest("hex");
    return {
        mappingProfile: input.mapping.profileKey,
        mappingVersion: input.mapping.version,
        plannedGraphRole: "model_version_immutable_named_graph",
        turtleSha256,
        tripleCount: parsed.length,
        spaceCount: input.spaces.length,
        assetCount: input.assets.length,
        manifestationCount: input.spaces.length + input.assets.length,
        warnings: input.modelVersionUuid ? [] : ["Persistent UUIDs marked candidate are preview identities, not final allocated identities."],
        spaces: input.spaces,
        assets: input.assets,
        sampleTriples: turtle.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("@prefix")).slice(0, 16),
        turtle,
    };
}
