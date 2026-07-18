/**
 * Statements SPARQL do grafo operacional (Prompt 5B) — ponto ÚNICO onde o
 * RDF dos ativos não modelados é construído e consultado.
 *
 * Regras de segurança (ADR-0026/0027):
 *  - APENAS INSERT DATA dirigido às URIs da própria operação — nunca DELETE,
 *    nunca CLEAR/DROP, nunca putGraph do grafo operacional inteiro; fechar
 *    uma atribuição = INSERIR o triplo validTo na atribuição antiga
 *    (corrente ≡ ausência de validTo);
 *  - todas as IRIs passam por iri() e todos os literais por *Literal()
 *    (escaping central — sem SPARQL injection);
 *  - todos os termos vêm de operationalVocabulary (nenhuma string RDF solta).
 */
import type { OperationalVocabulary } from "./operationalVocabulary.ts";
import { RDF_TYPE } from "./operationalVocabulary.ts";
import { dateTimeLiteral, decimalLiteral, iri, stringLiteral } from "./sparqlText.ts";

export interface AssignmentStatementInput {
    assignmentUri: string;
    spaceUri: string;
    validFromIso: string;
    source: string;
    observedAtIso?: string | null;
    confidence?: number | null;
}

export interface RegistrationStatementInput {
    assetUri: string;
    assetUuid: string;
    displayName: string;
    assetType: string;
    resourceKind: string;
    managerCode?: string | null;
    serialNumber?: string | null;
    registrationKey: string;
    sourceSystem: string;
    createdAtIso: string;
    activityUri: string;
    assignment?: AssignmentStatementInput | null;
}

function assignmentTriples(
    vocab: OperationalVocabulary,
    assetUri: string,
    activityUri: string,
    createdAtIso: string,
    input: AssignmentStatementInput
): string[] {
    const a = iri(input.assignmentUri);
    const lines = [
        `${iri(assetUri)} ${iri(vocab.hasLocationAssignment)} ${a} .`,
        `${a} ${iri(RDF_TYPE)} ${iri(vocab.LocationAssignment)} .`,
        `${a} ${iri(vocab.assignedAsset)} ${iri(assetUri)} .`,
        `${a} ${iri(vocab.assignedSpace)} ${iri(input.spaceUri)} .`,
        `${a} ${iri(vocab.validFrom)} ${dateTimeLiteral(input.validFromIso)} .`,
        `${a} ${iri(vocab.assignmentSource)} ${stringLiteral(input.source)} .`,
        `${a} ${iri(vocab.createdAt)} ${dateTimeLiteral(createdAtIso)} .`,
        `${a} ${iri(vocab.provenanceActivity)} ${iri(activityUri)} .`,
    ];
    if (input.observedAtIso) {
        lines.push(`${a} ${iri(vocab.observedAt)} ${dateTimeLiteral(input.observedAtIso)} .`);
    }
    if (input.confidence !== null && input.confidence !== undefined) {
        lines.push(`${a} ${iri(vocab.confidence)} ${decimalLiteral(input.confidence)} .`);
    }
    return lines;
}

/** INSERT DATA do registo de um ativo não modelado (+ atribuição inicial opcional). */
export function buildRegistrationInsert(
    vocab: OperationalVocabulary,
    graphUri: string,
    input: RegistrationStatementInput
): string {
    const s = iri(input.assetUri);
    const lines = [
        `${s} ${iri(RDF_TYPE)} ${iri(vocab.NonModelledAsset)} .`,
        `${s} ${iri(vocab.assetUuid)} ${stringLiteral(input.assetUuid)} .`,
        `${s} ${iri(vocab.displayName)} ${stringLiteral(input.displayName)} .`,
        `${s} ${iri(vocab.assetType)} ${stringLiteral(input.assetType)} .`,
        `${s} ${iri(vocab.resourceKind)} ${stringLiteral(input.resourceKind)} .`,
        `${s} ${iri(vocab.sourceSystem)} ${stringLiteral(input.sourceSystem)} .`,
        `${s} ${iri(vocab.registrationKey)} ${stringLiteral(input.registrationKey)} .`,
        `${s} ${iri(vocab.createdAt)} ${dateTimeLiteral(input.createdAtIso)} .`,
        `${s} ${iri(vocab.provenanceActivity)} ${iri(input.activityUri)} .`,
        `${iri(input.activityUri)} ${iri(RDF_TYPE)} ${iri(vocab.RegistrationActivity)} .`,
        `${iri(input.activityUri)} ${iri(vocab.createdAt)} ${dateTimeLiteral(input.createdAtIso)} .`,
    ];
    if (input.managerCode) {
        lines.push(`${s} ${iri(vocab.assetCode)} ${stringLiteral(input.managerCode)} .`);
    }
    if (input.serialNumber) {
        lines.push(`${s} ${iri(vocab.serialNumber)} ${stringLiteral(input.serialNumber)} .`);
    }
    if (input.assignment) {
        lines.push(...assignmentTriples(vocab, input.assetUri, input.activityUri, input.createdAtIso, input.assignment));
    }
    return `INSERT DATA { GRAPH ${iri(graphUri)} {\n${lines.join("\n")}\n} }`;
}

export interface MovementStatementInput {
    assetUri: string;
    /** Atribuição corrente que fica encerrada (validTo inserido — nunca apagada). */
    closedAssignmentUri: string;
    closedAtIso: string;
    newAssignment: AssignmentStatementInput;
    activityUri: string;
    createdAtIso: string;
}

/** INSERT DATA do movimento: encerra a atribuição anterior e cria a nova. */
export function buildMovementInsert(
    vocab: OperationalVocabulary,
    graphUri: string,
    input: MovementStatementInput
): string {
    const lines = [
        `${iri(input.closedAssignmentUri)} ${iri(vocab.validTo)} ${dateTimeLiteral(input.closedAtIso)} .`,
        ...assignmentTriples(vocab, input.assetUri, input.activityUri, input.createdAtIso, input.newAssignment),
        `${iri(input.activityUri)} ${iri(RDF_TYPE)} ${iri(vocab.LocationChangeActivity)} .`,
        `${iri(input.activityUri)} ${iri(vocab.createdAt)} ${dateTimeLiteral(input.createdAtIso)} .`,
    ];
    return `INSERT DATA { GRAPH ${iri(graphUri)} {\n${lines.join("\n")}\n} }`;
}

/** ASK: o recurso já existe no grafo operacional? (retry sem duplicar triples) */
export function buildResourceExistsAsk(graphUri: string, resourceUri: string): string {
    return `ASK { GRAPH ${iri(graphUri)} { ${iri(resourceUri)} ?p ?o } }`;
}

/** Verificação pós-escrita do registo: UUID + atribuição corrente (opcional). */
export function buildRegistrationVerificationSelect(
    vocab: OperationalVocabulary,
    graphUri: string,
    assetUri: string
): string {
    return `SELECT ?uuid ?assignment ?space WHERE { GRAPH ${iri(graphUri)} {
${iri(assetUri)} ${iri(vocab.assetUuid)} ?uuid .
OPTIONAL {
${iri(assetUri)} ${iri(vocab.hasLocationAssignment)} ?assignment .
?assignment ${iri(vocab.assignedSpace)} ?space .
FILTER NOT EXISTS { ?assignment ${iri(vocab.validTo)} ?closed }
}
} }`;
}

/** Atribuições CORRENTES (sem validTo) de um ativo — movimento e reconciliação. */
export function buildCurrentAssignmentsSelect(
    vocab: OperationalVocabulary,
    graphUri: string,
    assetUri: string
): string {
    return `SELECT ?assignment ?space WHERE { GRAPH ${iri(graphUri)} {
${iri(assetUri)} ${iri(vocab.hasLocationAssignment)} ?assignment .
?assignment ${iri(vocab.assignedSpace)} ?space .
FILTER NOT EXISTS { ?assignment ${iri(vocab.validTo)} ?closed }
} }`;
}

/** Descrição de um ativo do grafo (reconciliação/recriação segura de projeção). */
export function buildAssetDescriptionSelect(
    vocab: OperationalVocabulary,
    graphUri: string,
    assetUri: string
): string {
    const s = iri(assetUri);
    return `SELECT ?name ?assetType ?resourceKind ?assetCode ?serialNumber WHERE { GRAPH ${iri(graphUri)} {
${s} ${iri(vocab.displayName)} ?name .
${s} ${iri(vocab.assetType)} ?assetType .
${s} ${iri(vocab.resourceKind)} ?resourceKind .
OPTIONAL { ${s} ${iri(vocab.assetCode)} ?assetCode }
OPTIONAL { ${s} ${iri(vocab.serialNumber)} ?serialNumber }
} }`;
}

/** Recursos de um tipo do vocabulário (limpeza direcionada — nunca CLEAR/DROP). */
export function buildResourcesByTypeSelect(graphUri: string, typeUri: string): string {
    return `SELECT ?r WHERE { GRAPH ${iri(graphUri)} {
?r ${iri(RDF_TYPE)} ${iri(typeUri)} .
} }`;
}

/**
 * Remoção DIRECIONADA de um recurso: apaga os triplos onde é sujeito e os
 * triplos onde é objeto — nada mais. Idempotente (sem correspondência = no-op).
 */
export function buildResourceDeleteUpdates(graphUri: string, resourceUri: string): string[] {
    return [
        `DELETE WHERE { GRAPH ${iri(graphUri)} { ${iri(resourceUri)} ?p ?o } }`,
        `DELETE WHERE { GRAPH ${iri(graphUri)} { ?s ?p ${iri(resourceUri)} } }`,
    ];
}

/** Todos os ativos não modelados do grafo operacional (reconciliação). */
export function buildAllNonModelledAssetsSelect(
    vocab: OperationalVocabulary,
    graphUri: string
): string {
    return `SELECT ?asset ?uuid WHERE { GRAPH ${iri(graphUri)} {
?asset ${iri(RDF_TYPE)} ${iri(vocab.NonModelledAsset)} .
?asset ${iri(vocab.assetUuid)} ?uuid .
} }`;
}
