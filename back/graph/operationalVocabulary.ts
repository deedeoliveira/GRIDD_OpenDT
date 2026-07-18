/**
 * Vocabulário operacional MÍNIMO do projeto — versão operational-v1
 * (Prompt 5B; ADR-0024).
 *
 * O que isto É: o conjunto mínimo de termos RDF do namespace do PROJETO
 * necessário para registar ativos não modelados e as suas atribuições
 * temporais de localização no grafo operacional.
 *
 * O que isto NÃO é (deliberado):
 *  - NÃO é a ontologia de domínio da tese (seleção/alinhamento ontológico é
 *    etapa futura, fora do Prompt 5B);
 *  - NÃO é uma conversão do IFC (nenhum termo IFC é usado; ObjectType/Tag/
 *    GUID não existem para ativos não modelados);
 *  - NÃO introduz vocabulários externos (apenas rdf:type e datatypes XSD);
 *  - PODE ser alinhado ou substituído mais tarde — a versão no namespace
 *    (operational-v1) garante que uma futura v2 não reescreve silenciosamente
 *    o significado dos dados já escritos.
 *
 * TODAS as URIs de termos vêm deste módulo; nenhum outro ficheiro pode
 * escrever strings RDF de termos (guarda automatizada nos testes).
 */
import { validateBaseUri } from "./graphConfig.ts";

export const OPERATIONAL_VOCABULARY_VERSION = "operational-v1";

export const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

export interface OperationalVocabulary {
    /** Namespace dos termos: {base}/vocab/operational-v1# */
    readonly namespace: string;

    /* Classes */
    readonly NonModelledAsset: string;
    readonly LocationAssignment: string;
    readonly RegistrationActivity: string;
    readonly LocationChangeActivity: string;

    /* Propriedades do ativo */
    readonly assetUuid: string;
    readonly assetCode: string;
    readonly displayName: string;
    readonly assetType: string;      // tipo livre, ex. "PortableEquipment"
    readonly resourceKind: string;   // equipment | tool
    readonly serialNumber: string;
    readonly sourceSystem: string;
    readonly registrationKey: string;
    readonly hasLocationAssignment: string;

    /* Propriedades da atribuição de localização */
    readonly assignedAsset: string;
    readonly assignedSpace: string;
    readonly validFrom: string;
    readonly validTo: string;
    readonly observedAt: string;
    readonly assignmentSource: string;
    readonly confidence: string;

    /* Comuns */
    readonly createdAt: string;
    readonly provenanceActivity: string;
}

/**
 * Termos derivados da base URI configurada. Provisórios: quando a base de
 * produção for aprovada, os termos são re-emitidos sob essa base (decisão
 * documentada em ADR-0024).
 */
export function operationalVocabulary(baseUri: string): OperationalVocabulary {
    const base = validateBaseUri(baseUri, "baseUri");
    const ns = `${base}/vocab/${OPERATIONAL_VOCABULARY_VERSION}#`;
    const term = (local: string) => `${ns}${local}`;

    return {
        namespace: ns,
        NonModelledAsset: term("NonModelledAsset"),
        LocationAssignment: term("LocationAssignment"),
        RegistrationActivity: term("RegistrationActivity"),
        LocationChangeActivity: term("LocationChangeActivity"),
        assetUuid: term("assetUuid"),
        assetCode: term("assetCode"),
        displayName: term("displayName"),
        assetType: term("assetType"),
        resourceKind: term("resourceKind"),
        serialNumber: term("serialNumber"),
        sourceSystem: term("sourceSystem"),
        registrationKey: term("registrationKey"),
        hasLocationAssignment: term("hasLocationAssignment"),
        assignedAsset: term("assignedAsset"),
        assignedSpace: term("assignedSpace"),
        validFrom: term("validFrom"),
        validTo: term("validTo"),
        observedAt: term("observedAt"),
        assignmentSource: term("assignmentSource"),
        confidence: term("confidence"),
        createdAt: term("createdAt"),
        provenanceActivity: term("provenanceActivity"),
    };
}
