import crypto from "node:crypto";
import { DataFactory, Writer } from "n3";
import type { ActorEvidenceView, ResourceEvidenceView, StructuralEvidenceView } from "./semanticEvidenceTypes.ts";

const { namedNode, literal, quad } = DataFactory;
const RDF_TYPE = namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
const PROV_STARTED = namedNode("http://www.w3.org/ns/prov#startedAtTime");
const EV = "https://deedeoliveira.github.io/GRIDD_OpenDT/ontology/semantic-evidence-v1#";
const XSD_DATE_TIME = namedNode("http://www.w3.org/2001/XMLSchema#dateTime");

const statusIri: Record<string, string> = {
    verified: "Verified", revoked: "Revoked", expired: "Expired", available: "Verified",
    current: "Current", not_current: "NotCurrent", conforms: "Conforms", nonconformant: "Nonconformant",
    missing: "Missing", unavailable: "Unavailable", indeterminate: "Missing",
};

export async function buildReservationEvidenceGraph(input: {
    baseUri: string;
    runUuid: string;
    createdAt: string;
    start: string;
    end: string;
    actor: ActorEvidenceView;
    resource: ResourceEvidenceView;
    structural: StructuralEvidenceView;
    policyArtifactUuid: string;
}): Promise<{ turtle: string; sha256: string; runUri: string }> {
    const writer = new Writer({ prefixes: { ev: EV, prov: "http://www.w3.org/ns/prov#" } });
    const runUri = `${input.baseUri.replace(/\/+$/, "")}/semantic-evidence/run/${input.runUuid}`;
    const run = namedNode(runUri);
    const ev = (name: string) => namedNode(EV + name);
    writer.addQuad(quad(run, RDF_TYPE, ev("EvidenceRun")));
    writer.addQuad(quad(run, PROV_STARTED, literal(input.createdAt, XSD_DATE_TIME)));
    writer.addQuad(quad(run, ev("requestedStart"), literal(input.start, XSD_DATE_TIME)));
    writer.addQuad(quad(run, ev("requestedEnd"), literal(input.end, XSD_DATE_TIME)));
    writer.addQuad(quad(run, ev("usesArtifact"), namedNode(`${input.baseUri.replace(/\/+$/, "")}/semantic-artifact/${input.policyArtifactUuid}`)));

    const linkStatus = input.actor.linkStatus === "verified" ? "Verified"
        : input.actor.linkStatus === "revoked" ? "Revoked"
        : input.actor.reason === "actor_link_expired" ? "Expired" : "Unavailable";
    writer.addQuad(quad(run, ev("actorLinkStatus"), ev(linkStatus)));
    writer.addQuad(quad(run, ev("institutionalDatasetStatus"), ev(input.actor.datasetCurrent ? "Current" : "NotCurrent")));
    if (input.actor.linkUuid) writer.addQuad(quad(run, ev("actorLink"), namedNode(`${input.baseUri.replace(/\/+$/, "")}/actor-institutional-link/${input.actor.linkUuid}`)));
    if (input.actor.agentUri) writer.addQuad(quad(run, ev("evaluatedActor"), namedNode(input.actor.agentUri)));
    for (const role of input.actor.roles) {
        writer.addQuad(quad(run, ev("evaluatedActorRole"), namedNode(role.uri)));
        if (role.allowed) writer.addQuad(quad(run, ev("allowedActorRole"), namedNode(role.uri)));
    }

    if (input.resource.assetUri) writer.addQuad(quad(run, ev("evaluatedResource"), namedNode(input.resource.assetUri)));
    if (input.resource.tag) writer.addQuad(quad(run, ev("resourceTag"), literal(input.resource.tag)));
    if (input.resource.modelVersionUri) writer.addQuad(quad(run, ev("modelVersion"), namedNode(input.resource.modelVersionUri)));
    if (input.resource.manifestationUri) writer.addQuad(quad(run, ev("manifestation"), namedNode(input.resource.manifestationUri)));
    writer.addQuad(quad(run, ev("structuralStatus"), ev(statusIri[input.structural.status] ?? "Missing")));
    if (input.structural.validationRunUuid) writer.addQuad(quad(run, ev("structuralValidationRun"),
        namedNode(`${input.baseUri.replace(/\/+$/, "")}/semantic-validation/run/${input.structural.validationRunUuid}`)));

    const turtle = await new Promise<string>((resolve, reject) => writer.end((error, value) => error ? reject(error) : resolve(value)));
    return { turtle, sha256: crypto.createHash("sha256").update(turtle).digest("hex"), runUri };
}
