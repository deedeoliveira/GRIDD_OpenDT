import { iri, stringLiteral } from "../graph/sparqlText.ts";
import type { InstitutionalArtifactContext } from "./institutionalTypes.ts";

const UMINHO = "http://www.semanticweb.org/dekao/ontologies/2024/UMinho#";
const ORG = "http://www.w3.org/ns/org#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const SKOS = "http://www.w3.org/2004/02/skos/core#";
const FOAF = "http://xmlns.com/foaf/0.1/";

function labels(subject: string): string {
    return `OPTIONAL { ${subject} <${RDFS}label> ?label } OPTIONAL { ${subject} <${SKOS}prefLabel> ?prefLabel } OPTIONAL { ${subject} <${FOAF}name> ?name }`;
}

export function personByIdentifierQuery(context: InstitutionalArtifactContext, identifier: string): string {
    return `SELECT DISTINCT ?person ?label ?prefLabel ?name ?studentNumber ?type WHERE {
      GRAPH ${iri(context.dataset.namedGraphUri)} {
        ?person <${UMINHO}studentNumber> ${stringLiteral(identifier)} ; a ?type .
        OPTIONAL { ?person <${UMINHO}studentNumber> ?studentNumber }
        ${labels("?person")}
      }
    }`;
}

export function personByAgentUriQuery(context: InstitutionalArtifactContext, agentUri: string): string {
    const person = iri(agentUri);
    return `SELECT DISTINCT ?person ?label ?prefLabel ?name ?studentNumber ?type WHERE {
      GRAPH ${iri(context.dataset.namedGraphUri)} {
        BIND(${person} AS ?person) ?person a ?type .
        OPTIONAL { ?person <${UMINHO}studentNumber> ?studentNumber }
        ${labels("?person")}
      }
    }`;
}

export function membershipsQuery(context: InstitutionalArtifactContext, agentUri: string): string {
    return `SELECT DISTINCT ?membership ?organization ?organizationLabel ?organizationPrefLabel ?organizationName ?role ?roleLabel ?rolePrefLabel WHERE {
      GRAPH ${iri(context.dataset.namedGraphUri)} {
        ?membership <${ORG}member> ${iri(agentUri)} ; <${ORG}organization> ?organization .
        OPTIONAL { ?membership <${ORG}role> ?role }
        OPTIONAL { ?organization <${RDFS}label> ?organizationLabel }
        OPTIONAL { ?organization <${SKOS}prefLabel> ?organizationPrefLabel }
        OPTIONAL { ?organization <${FOAF}name> ?organizationName }
      }
      OPTIONAL { GRAPH ${iri(context.ontology.namedGraphUri)} {
        OPTIONAL { ?role <${RDFS}label> ?roleLabel }
        OPTIONAL { ?role <${SKOS}prefLabel> ?rolePrefLabel }
      } }
    }`;
}

export function rolesQuery(context: InstitutionalArtifactContext, agentUri: string): string {
    return `SELECT DISTINCT ?role ?roleLabel ?rolePrefLabel WHERE {
      GRAPH ${iri(context.dataset.namedGraphUri)} { ?membership <${ORG}member> ${iri(agentUri)} ; <${ORG}role> ?role . }
      OPTIONAL { GRAPH ${iri(context.ontology.namedGraphUri)} {
        OPTIONAL { ?role <${RDFS}label> ?roleLabel } OPTIONAL { ?role <${SKOS}prefLabel> ?rolePrefLabel }
      } }
    }`;
}

export function supervisorsQuery(context: InstitutionalArtifactContext, agentUri: string): string {
    return `SELECT DISTINCT ?supervisor ?label ?prefLabel ?name WHERE {
      GRAPH ${iri(context.dataset.namedGraphUri)} {
        ${iri(agentUri)} <${UMINHO}isSupervisedBy> ?supervisor . ${labels("?supervisor")}
      }
    }`;
}

export function suborganizationsQuery(context: InstitutionalArtifactContext, organizationUri: string): string {
    return `SELECT DISTINCT ?organization ?label ?prefLabel ?name WHERE {
      GRAPH ${iri(context.dataset.namedGraphUri)} {
        ?organization <${ORG}subOrganizationOf> ${iri(organizationUri)} . ${labels("?organization")}
      }
    }`;
}

export function doctoralStudentsByOrganizationQuery(context: InstitutionalArtifactContext, organizationUri: string): string {
    return `SELECT DISTINCT ?person ?label ?prefLabel ?name ?studentNumber ?type WHERE {
      GRAPH ${iri(context.dataset.namedGraphUri)} {
        ?membership <${ORG}member> ?person ; <${ORG}organization> ${iri(organizationUri)} ; <${ORG}role> <${UMINHO}DoctoralStudentRole> .
        ?person a ?type . OPTIONAL { ?person <${UMINHO}studentNumber> ?studentNumber } ${labels("?person")}
      }
    }`;
}

export function supervisingProfessorsQuery(context: InstitutionalArtifactContext): string {
    return `SELECT DISTINCT ?person ?label ?prefLabel ?name ?type WHERE {
      GRAPH ${iri(context.dataset.namedGraphUri)} {
        ?student <${UMINHO}isSupervisedBy> ?person . ?person a ?type . ${labels("?person")}
      }
    }`;
}

export function peopleWithMultipleRolesQuery(context: InstitutionalArtifactContext): string {
    return `SELECT DISTINCT ?person ?label ?prefLabel ?name ?type WHERE {
      GRAPH ${iri(context.dataset.namedGraphUri)} {
        ?membership <${ORG}member> ?person ; <${ORG}role> ?roleA, ?roleB . FILTER(?roleA != ?roleB)
        ?person a ?type . ${labels("?person")}
      }
    }`;
}
