import type { ExtractedIfcModel } from "../requirements/modelRequirementsTypes.ts";
import type { IdsProfileMetadata, NormalizedRequirementFinding } from "../requirements/idsValidationTypes.ts";
import type { SemanticValidationReport } from "../semanticValidation/semanticValidationTypes.ts";

export type MaterialisationMode = "disabled" | "best_effort" | "required";

export interface VisibleIdsRequirement {
    requirementId: string;
    specification: string;
    appliesTo: string;
    requires: string;
    cardinality: string;
    expectedPattern: string | null;
}

export interface IntakeProfile extends IdsProfileMetadata {
    source: "governed_active_profile" | "temporary_uploaded_profile";
    originalFilename: string;
    executorName: string;
    executorVersion: string;
    specificationCount: number;
    requirements: VisibleIdsRequirement[];
}

/** Persistent-space resolution status for an IfcSpace candidate (ADR-0052). */
export type PreviewSpaceStatus =
    | "existing"
    | "new"
    | "invalid"
    | "missing_name"
    | "inventory_code_collision"
    | "schema_error";

/**
 * Stable machine-readable code for a preview outcome (ADR-0052). Exposed alongside a
 * concise operational message so the BIM Manager UI never has to parse prose — and never
 * sees raw SQL or internal stack traces.
 */
export type PreviewSpaceCode =
    | "existing"
    | "new"
    | "invalid_globalid"
    | "duplicate_candidate_globalid"
    | "missing_space_name"
    | "inventory_code_collision"
    | "canonical_schema_missing"
    | "canonical_inconsistency";

export interface PreviewSpace {
    persistentUuid: string | "candidate";
    /** Candidate institutional inventory code, from IfcSpace.Name (ADR-0052 §C). */
    inventoryCode: string;
    ifcGuid: string;
    ifcClass: "IfcSpace";
    storey: string | null;
    persistentUri: string;
    manifestationUri: string;
    // ---- ADR-0052: GlobalId is the identity authority ----
    // Optional so the RDF/version-resource builders (which project already-persisted
    // versions) are unaffected; the intake preview always populates every field.
    /** IfcSpace.GlobalId — the persistent identity key (exact, case-sensitive). */
    ifcGlobalId?: string;
    /**
     * IFC entity occurrence id. Distinguishes two IfcSpace occurrences that share one
     * GlobalId; used only for the manifestation/candidate URI and diagnostics — NEVER a
     * persistent identity source. Null when the display-only fallback was used.
     */
    ifcEntityId?: number | null;
    /** IfcSpace.Name — the institutional inventory code (same value as inventoryCode). */
    name?: string | null;
    /** IfcSpace.LongName — the informational label (ADR-0052 §D). */
    longName?: string | null;
    /** Resolution against existing persistent identity by GlobalId. */
    persistentSpaceStatus?: PreviewSpaceStatus;
    /** Stable machine-readable code paired with the status. */
    blockingCode?: PreviewSpaceCode | null;
    /** Existing persistent space when matched by GlobalId. */
    existingSpaceId?: number | null;
    existingSpaceUuid?: string | null;
    /** Current stored inventory code of the matched persistent space (if existing). */
    existingInventoryCode?: string | null;
    /** True when the candidate inventory code differs from the stored current one. */
    inventoryCodeChanged?: boolean;
    /** Populated for a blocking status (inventory_code_collision/invalid). */
    blockingError?: string | null;
}

export interface PreviewAsset {
    /**
     * TAG-1 §9 (V3) — correlacionado com {@link PreviewAsset.persistentAssetStatus}:
     *  - `existing`  → o UUID persistente REAL do ativo reutilizado;
     *  - `new`       → o sentinela `"candidate"`, cujo ÚNICO significado em todo o
     *                  código é "vai ser criado aqui um novo recurso persistente"
     *                  (o mesmo significado, binário, que tem em {@link PreviewSpace});
     *  - `ambiguous` → `null`. NUNCA `"candidate"`: ambíguo não é "novo", é
     *                  "não resolvido, exige revisão humana". Não existe um segundo
     *                  sentinela textual — a ausência de UUID resolvido é `null`.
     */
    persistentUuid: string | "candidate" | null;
    tag: string;
    serialNumber: string | null;
    manufacturer: string | null;
    ifcGuid: string;
    ifcClass: string;
    /**
     * Display-only, version-accurate inventory code of the containing space (from the
     * IfcSpace.Name occurrence in preview, or the version's space-binding snapshot for a
     * persisted version). NEVER the relationship key — a mutable inventory code must not
     * decide the RDF equipment→space edge (ADR-0052 §F).
     */
    containingSpace: string | null;
    /**
     * The persistent-space URI (`.../space/{uuid}`) of the containing space — the ONLY
     * authority for the `project:containedInSpace` edge. Resolved from the containing
     * IfcSpace occurrence GlobalId (preview) or `asset_bindings.space_id` (persisted
     * version), so the location link stays valid across IfcSpace.Name / LongName changes
     * and historical rematerialisation. Null when the asset has no located space.
     */
    containingSpacePersistentUri: string | null;
    persistentUri: string;
    manifestationUri: string;
    /**
     * TAG-1 §9 (V2) — resultado da resolução de identidade de PORTEFÓLIO pela Tag
     * canónica, com as mesmas semânticas do caminho autoritativo:
     *  - `existing`  — exatamente um ativo persistente com esta Tag canónica
     *                  (mesmo que noutro modelo): o upload vai REUTILIZÁ-LO;
     *  - `new`       — nenhum ativo no portefólio com esta Tag canónica;
     *  - `ambiguous` — MAIS DO QUE UM ativo persistente com esta Tag canónica
     *                  (duplicados legados). A pré-visão NÃO escolhe um: fica com
     *                  `persistentUuid === null`, tal como o resolver devolve
     *                  `ambiguous` e cria um caso de reconciliação.
     *
     * OBRIGATÓRIO (V3): todo o construtor consegue determiná-lo sem inventar um
     * valor — o construtor da pré-visão já o calcula incondicionalmente, e os
     * construtores que projetam versões JÁ PERSISTIDAS têm, por definição, um
     * `asset_uuid` real por linha, logo `existing`. Ser obrigatório é o que
     * permite ao consumidor decidir SEMPRE pelo estado, nunca pelo sentinela.
     *
     * INVARIANTE (V3): `persistentAssetStatus === "ambiguous"` e
     * `persistentUuid === "candidate"` NÃO podem coocorrer.
     */
    persistentAssetStatus: "existing" | "new" | "ambiguous";
    /**
     * Ativos em conflito quando `persistentAssetStatus === "ambiguous"` (evidência,
     * sem escolher um). `null` em `existing`/`new` — nunca omitido.
     */
    ambiguousAssetUuids: string[] | null;
}

export interface RdfPreview {
    mappingProfile: string;
    mappingVersion: string;
    plannedGraphRole: "model_version_immutable_named_graph";
    turtleSha256: string;
    tripleCount: number;
    spaceCount: number;
    assetCount: number;
    manifestationCount: number;
    warnings: string[];
    spaces: PreviewSpace[];
    assets: PreviewAsset[];
    sampleTriples: string[];
    turtle: string;
}

export interface PreflightRun {
    runUuid: string;
    correlationId: string;
    createdAt: string;
    expiresAt: string;
    modelId: number;
    ifc: {
        originalFilename: string;
        serverComputedSha256: string;
        byteSize: number;
        detectedIfcSchema: string | null;
        entityCounts: Record<string, number>;
    };
    ids: Omit<IntakeProfile, "absolutePath">;
    validation: {
        overallStatus: "pass" | "fail" | "error";
        idsStatus: "pass" | "fail" | "error" | "not_evaluated";
        projectRulesStatus: "pass" | "fail" | "error" | "not_evaluated";
        blocking: boolean;
        findings: NormalizedRequirementFinding[];
    };
    rdfPreview: RdfPreview;
    shaclValidation?: SemanticValidationReport;
    extractedModel: ExtractedIfcModel;
}

export interface IfcRdfMappingProfile {
    profileKey: string;
    version: string;
    description: string;
    executionModel: "declarative_allowlist";
    namespaces: Record<string, string>;
    includedIfcClasses: string[];
    includedProperties: string[];
    uriPatterns: Record<string, string>;
    rdfClasses: Record<string, string>;
    predicates: string[];
    identityRules: Record<string, string>;
    provenanceRules: string[];
    deliberatelyExcluded: string[];
}
