/**
 * Tipos e erros dos ativos NÃO modelados (Prompt 5B).
 *
 * Um ativo não modelado NÃO tem entity, binding, IFC GUID, Tag EQP- nem
 * ObjectType: a identidade principal é o asset_uuid gerado pela aplicação,
 * a URI deriva EXCLUSIVAMENTE desse UUID, o código do gestor é opcional e a
 * localização é uma atribuição temporal separada (nunca parte da identidade).
 */

export type NonModelledResourceKind = "equipment" | "tool";

/** Fontes de atribuição de localização. Nesta etapa só 'manual' é aceite via API. */
export const LOCATION_SOURCES = ["manual", "external_system", "sensor_inference"] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];
export const IMPLEMENTED_LOCATION_SOURCES: readonly LocationSource[] = ["manual"];

export interface RegisterNonModelledAssetCommand {
    /** Chave idempotente do comando (não é identidade nem URI pública do ativo). */
    registrationKey: string;
    name: string;
    /** Tipo livre do projeto (ex.: "PortableEquipment") — nunca uma classe IFC. */
    assetType: string;
    resourceKind: NonModelledResourceKind;
    managerCode?: string | null;
    serialNumber?: string | null;
    initialSpaceId?: number | null;
}

export interface MoveNonModelledAssetCommand {
    /** Chave idempotente do comando de movimento. */
    movementKey: string;
    assetId: number;
    newSpaceId: number;
    /** Só 'manual' é aceite nesta etapa (sensor_inference/external_system são futuros). */
    source?: LocationSource;
}

export interface NonModelledAssetResult {
    assetId: number;
    assetUuid: string;
    assetUri: string;
    name: string;
    assetType: string;
    resourceKind: string;
    managerCode: string | null;
    serialNumber: string | null;
    reservable: boolean;
    policyDecision: string;
    lifecycleStatus: string;
    /** 'located' | 'pending_location' — condição operacional, não identidade. */
    locationStatus: "located" | "pending_location";
    currentLocation: {
        assignmentUuid: string;
        spaceId: number;
        spaceUuid: string | null;
        spaceCode: string | null;
        validFrom: string;
    } | null;
    operation: { id: number | null; operationUuid: string; status: string; attemptCount: number };
}

/** Erro tipado da camada de ativos não modelados (statusCode para as rotas). */
export class NonModelledAssetError extends Error {
    readonly statusCode: number;
    readonly code: string;

    constructor(code: string, statusCode: number, message: string) {
        super(message);
        this.name = "NonModelledAssetError";
        this.code = code;
        this.statusCode = statusCode;
    }
}
