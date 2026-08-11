import type { SemanticArtifactRow } from "../semantic/artifactTypes.ts";
import type { CurrentArtifactSetRow, SemanticArtifactDatabasePort } from "../utils/semanticArtifactDatabase.ts";

/**
 * Change C — coherent, pinned semantic execution context for ONE authoritative model
 * intake attempt.
 *
 * GOVERNANCE MODEL (frozen): IDS, RDF mapping and SHACL shapes are INDEPENDENTLY
 * versioned governed artifact families. Runtime never infers compatibility from equal
 * semantic-version numbers across families, and there is no compatibility-set allow-list
 * or release manifest. Deciding which combination of governed revisions is valid is the
 * BIM manager's institutional responsibility, expressed by which revision each family
 * currently points at. Runtime's job is narrower and total: capture that combination
 * coherently, pin it, execute it, and persist it. A snapshot of ids=1.2 / mapping=1.3 /
 * shapes=1.1 is therefore perfectly acceptable, provided each artifact individually
 * passes its own eligibility contract.
 *
 * A single `createVersion` attempt used to re-resolve "what is currently active" once
 * per consumer (IDS profile, RDF mapping profile, SHACL shapes), each through its own
 * unlocked `findFamilyByKey` + `findArtifactById(current_artifact_id)` pair. An
 * administrator activating a new governed triplet (Change B) between those reads could
 * therefore make one attempt persist a MIXED revision result. This module captures ONE
 * coherent snapshot of all three current pointers (a single SQL statement), validates
 * that every captured artifact is individually eligible, and hands back an
 * immutable selection that every later authoritative resolution in the attempt pins to
 * BY ARTIFACT ID — never by re-following `current_artifact_id`.
 *
 * Preview endpoints deliberately do NOT use this: they keep resolving "active" freshly.
 */

export type SemanticContextErrorCode =
    /** A requested governed family does not exist at all. */
    | "semantic_context_family_missing"
    /** The family exists but has no current artifact, or the pointer is dangling. */
    | "semantic_context_current_pointer_missing"
    /** The joined artifact does not belong to the family that points at it. */
    | "semantic_context_family_linkage_invalid"
    /** The pointed-at artifact was not `active` at capture time. */
    | "semantic_context_artifact_not_active"
    /** storage_mode / validation_status / named_graph_uri violate the per-family contract. */
    | "semantic_context_artifact_ineligible"
    /** A pinned artifact id no longer resolves to a row. */
    | "pinned_artifact_missing"
    /** The pinned artifact does not belong to the family named in the snapshot. */
    | "pinned_artifact_family_mismatch"
    /** An immutable identity field (semantic_version / sha256 / named_graph_uri) changed in place. */
    | "pinned_artifact_revision_drift"
    /** The pinned artifact was never activated (staged / validated). */
    | "pinned_artifact_not_yet_eligible"
    /** The pinned artifact's activation was revoked (retired / failed). */
    | "pinned_artifact_revoked";

/**
 * Governance failure while capturing or validating the pinned execution context. Mirrors
 * the `code`-carrying convention of `SemanticArtifactError` / `SemanticValidationError` /
 * `IntakeError`, but stays a distinct type so a governance capture failure is never
 * mistaken for an artifact-registry write failure or an HTTP input error.
 */
export class SemanticContextError extends Error {
    constructor(readonly code: SemanticContextErrorCode, message: string) {
        super(message);
        this.name = "SemanticContextError";
    }
}

export interface PinnedArtifactSelection {
    readonly artifactId: number;
    readonly familyKey: string;
    readonly semanticVersion: string;
    readonly sha256: string;
}

export interface PinnedGraphArtifactSelection extends PinnedArtifactSelection {
    readonly namedGraphUri: string;
}

/**
 * The immutable pinned selection for one authoritative intake attempt. Intentionally
 * carries only identity + integrity fields: `repository_relative_path`, `storage_mode`
 * and executor metadata stay INTERNAL to each resolver's integrity checks, so this type
 * can never become a way to smuggle a path or a storage decision past those checks.
 * No `capturedAt` field — no production logging or diagnostics consumes one today.
 */
export interface SemanticExecutionContext {
    readonly ids: PinnedArtifactSelection;
    readonly mapping: PinnedArtifactSelection;
    readonly shapes: PinnedGraphArtifactSelection;
}

export interface SemanticExecutionContextFamilyKeys {
    idsFamilyKey: string;
    mappingFamilyKey: string;
    shapesFamilyKey: string;
}

/**
 * The governed family keys this context is captured from. Declared HERE rather than
 * imported from `semantic/ifc4x3TripletActivationService.ts`: that module's family list
 * is a rollout-scoped descriptor for Change B's atomic triplet ACTIVATION mechanism,
 * which is a separate concern from Change C's coherent SELECTION concern. Coupling the
 * two would re-introduce, by the back door, the idea that these three families move as
 * one versioned unit — exactly what the frozen governance model rejects.
 */
export const DEFAULT_SEMANTIC_CONTEXT_FAMILY_KEYS: SemanticExecutionContextFamilyKeys = {
    idsFamilyKey: "oswadt-ifc4-model-requirements",
    mappingFamilyKey: "oswadt-ifc4-minimal-rdf-mapping",
    shapesFamilyKey: "oswadt-model-rdf-structural-shapes",
};

type FileExpectation = { storageMode: "file_executed"; validationStatus: "file_verified"; namedGraph: "absent" };
type GraphExpectation = { storageMode: "graph_backed"; validationStatus: "graph_verified"; namedGraph: "present" };

const FILE_EXPECTATION: FileExpectation = { storageMode: "file_executed", validationStatus: "file_verified", namedGraph: "absent" };
const GRAPH_EXPECTATION: GraphExpectation = { storageMode: "graph_backed", validationStatus: "graph_verified", namedGraph: "present" };

/**
 * Shared by-ID fetch + defensive re-verification used by all three pinned resolvers.
 *
 * Resolves the artifact DIRECTLY by its pinned id — `current_artifact_id` is never read.
 * The family key is still mapped to a family id through `findFamilyByKey`, but only to
 * perform an identity check (does this artifact belong to that family?); the family's
 * current pointer is deliberately ignored.
 *
 * `semantic_version` / `sha256` (and, for graph-backed artifacts, `named_graph_uri`) are
 * re-compared against the captured snapshot. Artifact rows are immutable by design, so a
 * mismatch should be impossible; the check is defence-in-depth against any future code
 * path that ever mutated an existing revision's identity in place.
 *
 * `active` and `superseded` are both accepted: an attempt that pinned a revision before
 * an administrator activated the next one must still complete against the revision it
 * validated. `staged`/`validated` (never activated) and `retired`/`failed` (revoked) are
 * rejected with distinct codes.
 */
export async function resolvePinnedArtifactRow(
    db: Pick<SemanticArtifactDatabasePort, "findFamilyByKey" | "findArtifactById">,
    selection: PinnedArtifactSelection & { namedGraphUri?: string },
): Promise<SemanticArtifactRow> {
    const artifact = await db.findArtifactById(selection.artifactId);
    if (!artifact) {
        throw new SemanticContextError("pinned_artifact_missing",
            `The pinned semantic artifact ${selection.artifactId} ('${selection.familyKey}') no longer exists.`);
    }
    const family = await db.findFamilyByKey(selection.familyKey);
    if (!family || Number(artifact.family_id) !== Number(family.id)) {
        throw new SemanticContextError("pinned_artifact_family_mismatch",
            `The pinned semantic artifact ${selection.artifactId} does not belong to family '${selection.familyKey}'.`);
    }
    if (artifact.semantic_version !== selection.semanticVersion || artifact.sha256 !== selection.sha256) {
        throw new SemanticContextError("pinned_artifact_revision_drift",
            `The pinned semantic artifact ${selection.artifactId} ('${selection.familyKey}') no longer matches the captured immutable revision identity.`);
    }
    if (selection.namedGraphUri !== undefined && artifact.named_graph_uri !== selection.namedGraphUri) {
        throw new SemanticContextError("pinned_artifact_revision_drift",
            `The pinned semantic artifact ${selection.artifactId} ('${selection.familyKey}') no longer declares the captured named graph URI.`);
    }
    if (artifact.lifecycle_status === "staged" || artifact.lifecycle_status === "validated") {
        throw new SemanticContextError("pinned_artifact_not_yet_eligible",
            `The pinned semantic artifact ${selection.artifactId} ('${selection.familyKey}') was never activated (lifecycle_status='${artifact.lifecycle_status}').`);
    }
    if (artifact.lifecycle_status !== "active" && artifact.lifecycle_status !== "superseded") {
        throw new SemanticContextError("pinned_artifact_revoked",
            `The pinned semantic artifact ${selection.artifactId} ('${selection.familyKey}') has been revoked (lifecycle_status='${artifact.lifecycle_status}').`);
    }
    return artifact;
}

function requireRow(rows: CurrentArtifactSetRow[], familyKey: string): CurrentArtifactSetRow {
    const row = rows.find((candidate) => candidate.family_key === familyKey);
    if (!row) {
        throw new SemanticContextError("semantic_context_family_missing",
            `Governed semantic family '${familyKey}' does not exist; the pinned execution context cannot be captured.`);
    }
    return row;
}

function assertEligible(row: CurrentArtifactSetRow, expectation: FileExpectation | GraphExpectation): void {
    if (row.current_artifact_id === null) {
        throw new SemanticContextError("semantic_context_current_pointer_missing",
            `Governed semantic family '${row.family_key}' has no current artifact.`);
    }
    if (row.artifact_id === null) {
        throw new SemanticContextError("semantic_context_current_pointer_missing",
            `Governed semantic family '${row.family_key}' points at an artifact revision that no longer exists.`);
    }
    if (Number(row.artifact_family_id) !== Number(row.family_id)) {
        throw new SemanticContextError("semantic_context_family_linkage_invalid",
            `The current artifact of family '${row.family_key}' belongs to a different family.`);
    }
    if (row.lifecycle_status !== "active") {
        throw new SemanticContextError("semantic_context_artifact_not_active",
            `The current artifact of family '${row.family_key}' was not active at capture time (lifecycle_status='${row.lifecycle_status}').`);
    }
    if (row.storage_mode !== expectation.storageMode || row.validation_status !== expectation.validationStatus) {
        throw new SemanticContextError("semantic_context_artifact_ineligible",
            `The current artifact of family '${row.family_key}' is not a ${expectation.storageMode}/${expectation.validationStatus} governed revision.`);
    }
    if (expectation.namedGraph === "absent" && row.named_graph_uri !== null) {
        throw new SemanticContextError("semantic_context_artifact_ineligible",
            `The current file-executed artifact of family '${row.family_key}' must not declare a named graph URI.`);
    }
    if (expectation.namedGraph === "present" && (row.named_graph_uri === null || row.named_graph_uri === "")) {
        throw new SemanticContextError("semantic_context_artifact_ineligible",
            `The current graph-backed artifact of family '${row.family_key}' has no named graph URI.`);
    }
    if (typeof row.semantic_version !== "string" || row.semantic_version === ""
        || typeof row.sha256 !== "string" || row.sha256 === "") {
        throw new SemanticContextError("semantic_context_artifact_ineligible",
            `The current artifact of family '${row.family_key}' has no usable immutable identity (semantic_version/sha256).`);
    }
}

/**
 * Captures ONE coherent snapshot of the three governed current pointers and fails closed
 * on every governance violation that runtime is competent to judge: a missing family, a
 * NULL or dangling current pointer, an artifact linked to the wrong family, an artifact
 * that was not `active` at capture time, and any storage_mode / validation_status /
 * named-graph / immutable-identity violation of the per-family contract.
 *
 * It deliberately performs NO cross-family comparison. Whether ids=1.2 is "compatible
 * with" mapping=1.3 is a governance judgement the BIM manager makes by activating those
 * revisions; runtime cannot and must not re-derive it from version numbers.
 */
export async function buildSemanticExecutionContext(
    db: Pick<SemanticArtifactDatabasePort, "resolveCurrentArtifactSet">,
    familyKeys: SemanticExecutionContextFamilyKeys = DEFAULT_SEMANTIC_CONTEXT_FAMILY_KEYS,
): Promise<SemanticExecutionContext> {
    const requested = [familyKeys.idsFamilyKey, familyKeys.mappingFamilyKey, familyKeys.shapesFamilyKey];
    const rows = await db.resolveCurrentArtifactSet(requested);

    const idsRow = requireRow(rows, familyKeys.idsFamilyKey);
    const mappingRow = requireRow(rows, familyKeys.mappingFamilyKey);
    const shapesRow = requireRow(rows, familyKeys.shapesFamilyKey);

    assertEligible(idsRow, FILE_EXPECTATION);
    assertEligible(mappingRow, FILE_EXPECTATION);
    assertEligible(shapesRow, GRAPH_EXPECTATION);

    // No cross-family version comparison happens here, by design. Each family's current
    // revision has already been validated on its own terms above; the combination itself
    // is authoritative because the BIM manager activated it.
    const versions = {
        ids: idsRow.semantic_version as string,
        mapping: mappingRow.semantic_version as string,
        shapes: shapesRow.semantic_version as string,
    };

    return freezeContext(idsRow, mappingRow, shapesRow, versions);
}

function freezeContext(
    idsRow: CurrentArtifactSetRow,
    mappingRow: CurrentArtifactSetRow,
    shapesRow: CurrentArtifactSetRow,
    versions: { ids: string; mapping: string; shapes: string },
): SemanticExecutionContext {
    return Object.freeze({
        ids: Object.freeze({
            artifactId: Number(idsRow.artifact_id),
            familyKey: idsRow.family_key,
            semanticVersion: versions.ids,
            sha256: idsRow.sha256 as string,
        }),
        mapping: Object.freeze({
            artifactId: Number(mappingRow.artifact_id),
            familyKey: mappingRow.family_key,
            semanticVersion: versions.mapping,
            sha256: mappingRow.sha256 as string,
        }),
        shapes: Object.freeze({
            artifactId: Number(shapesRow.artifact_id),
            familyKey: shapesRow.family_key,
            semanticVersion: versions.shapes,
            sha256: shapesRow.sha256 as string,
            namedGraphUri: shapesRow.named_graph_uri as string,
        }),
    });
}
