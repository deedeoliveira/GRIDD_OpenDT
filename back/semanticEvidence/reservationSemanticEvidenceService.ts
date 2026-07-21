import crypto from "node:crypto";
import { loadGraphConfig } from "../graph/graphConfig.ts";
import { getGraphClient } from "../graph/graphClientProvider.ts";
import { reservationEvidenceGraphUri, reservationPolicyReportGraphUri } from "../graph/namedGraphs.ts";
import type { GraphClient } from "../graph/graphTypes.ts";
import { normalizeActorKey, ActorInstitutionalLinkError } from "../semantic/actorInstitutionalLinkTypes.ts";
import { createInstitutionalRuntime } from "../semantic/institutionalRuntime.ts";
import type { InstitutionalActorContext } from "../semantic/institutionalTypes.ts";
import { PyShaclValidationProvider } from "../semanticValidation/pyShaclValidationProvider.ts";
import type { SemanticValidationProvider } from "../semanticValidation/semanticValidationTypes.ts";
import { SemanticEvidenceDatabase, type SemanticEvidenceDatabasePort } from "../utils/semanticEvidenceDatabase.ts";
import { buildReservationEvidenceGraph } from "./evidenceGraphBuilder.ts";
import { loadSemanticEvidenceConfig, type SemanticEvidenceConfig } from "./semanticEvidenceConfig.ts";
import { SemanticPolicyService } from "./semanticPolicyService.ts";
import type { PolicySelection } from "./semanticEvidenceTypes.ts";
import {
    SemanticEvidenceError,
    type ActorEvidenceView,
    type ResourceEvidenceView,
    type SemanticEvidenceInputs,
    type SemanticEvidenceResponse,
    type StructuralEvidenceView,
} from "./semanticEvidenceTypes.ts";

const ALLOWED_ROLES = new Set([
    "http://www.semanticweb.org/dekao/ontologies/2024/UMinho#DoctoralStudentRole",
    "http://www.semanticweb.org/dekao/ontologies/2024/UMinho#ProfessorRole",
    "http://www.semanticweb.org/dekao/ontologies/2024/UMinho#ResearcherRole",
]);

export interface InstitutionalContextPort { getActorContext(actorKey: string, correlationId?: string): Promise<InstitutionalActorContext>; }
export interface SqlAvailabilityPort {
    hasApprovedConflict(assetId: number, start: Date, end: Date): Promise<boolean>;
    hasActorConflict(assetId: number, actorId: string, start: Date, end: Date): Promise<boolean>;
}
export interface SemanticPolicyResolverPort { resolveActive(familyKey?: string): Promise<PolicySelection>; }

export interface SemanticEvidenceDependencies {
    config?: SemanticEvidenceConfig;
    institutional?: InstitutionalContextPort;
    database?: SemanticEvidenceDatabasePort;
    availability?: SqlAvailabilityPort;
    policies?: SemanticPolicyResolverPort;
    provider?: SemanticValidationProvider;
    graph?: GraphClient;
    now?: () => Date;
    newUuid?: () => string;
    baseUri?: string;
}

function actorReference(actorKey: string): string {
    return actorKey.startsWith("TEST-") ? actorKey
        : `sha256:${crypto.createHash("sha256").update(actorKey).digest("hex").slice(0, 16)}`;
}

function uniqueOrganizations(context: InstitutionalActorContext) {
    const values = new Map<string, { uri: string; label: string }>();
    for (const membership of context.memberships) values.set(membership.organization.uri, membership.organization);
    return [...values.values()];
}

export class ReservationSemanticEvidenceService {
    private readonly config: SemanticEvidenceConfig;
    private readonly institutional: InstitutionalContextPort;
    private readonly database: SemanticEvidenceDatabasePort;
    private readonly availability: SqlAvailabilityPort;
    private readonly policies: SemanticPolicyResolverPort;
    private readonly provider: SemanticValidationProvider;
    private readonly graph: GraphClient;
    private readonly now: () => Date;
    private readonly newUuid: () => string;
    private readonly baseUri: string | null;

    constructor(dependencies: SemanticEvidenceDependencies = {}) {
        this.config = dependencies.config ?? loadSemanticEvidenceConfig();
        this.institutional = dependencies.institutional ?? createInstitutionalRuntime().context;
        this.database = dependencies.database ?? new SemanticEvidenceDatabase();
        this.availability = dependencies.availability ?? {
            async hasApprovedConflict(assetId, start, end) {
                const { default: database } = await import("../utils/reservationDatabase.ts");
                return database.hasApprovedConflict(assetId, start, end);
            },
            async hasActorConflict(assetId, actorId, start, end) {
                const { default: database } = await import("../utils/reservationDatabase.ts");
                return database.hasActorConflict(assetId, actorId, start, end);
            },
        };
        this.policies = dependencies.policies ?? new SemanticPolicyService();
        this.provider = dependencies.provider ?? new PyShaclValidationProvider();
        this.graph = dependencies.graph ?? getGraphClient();
        this.now = dependencies.now ?? (() => new Date());
        this.newUuid = dependencies.newUuid ?? (() => crypto.randomUUID());
        this.baseUri = dependencies.baseUri ?? null;
    }

    async evaluate(raw: SemanticEvidenceInputs, correlationId = crypto.randomUUID()): Promise<SemanticEvidenceResponse> {
        if (!this.config.enabled || this.config.mode !== "shadow") {
            throw new SemanticEvidenceError("semantic_evidence_disabled", "Semantic evidence is disabled.", 503);
        }
        const normalized = normalizeActorKey(raw.actorKey);
        const assetId = Number(raw.assetId);
        const start = new Date(raw.start);
        const end = new Date(raw.end);
        if (!Number.isInteger(assetId) || assetId <= 0) throw new SemanticEvidenceError("invalid_asset", "Select a valid asset.");
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start || start <= this.now()) {
            throw new SemanticEvidenceError("invalid_interval", "Select a future interval whose end is after its start.");
        }
        const started = Date.now();
        const runUuid = this.newUuid();
        console.log(JSON.stringify({ type: "semantic_evidence_started", correlationId, runUuid,
            actorReference: actorReference(normalized.original), assetId, start: start.toISOString(), end: end.toISOString(), at: this.now().toISOString() }));
        try {
            const graphConfig = this.baseUri ? { configured: true as const, config: { baseUri: this.baseUri } }
                : loadGraphConfig();
            if (!graphConfig.configured) throw new SemanticEvidenceError("graph_not_configured", graphConfig.reason, 503);
            const policy = await this.policies.resolveActive(this.config.policyFamilyKey);
            const [actor, resolvedResource, approvedConflict, actorConflict] = await Promise.all([
                this.resolveActor(normalized.original, correlationId),
                this.resolveResource(assetId, graphConfig.config.baseUri),
                this.availability.hasApprovedConflict(assetId, start, end),
                this.availability.hasActorConflict(assetId, normalized.original, start, end),
            ]);
            const resource = resolvedResource.resource;
            const structural = resolvedResource.structural;
            const createdAt = this.now().toISOString();
            const evidence = await buildReservationEvidenceGraph({ baseUri: graphConfig.config.baseUri, runUuid,
                createdAt, start: start.toISOString(), end: end.toISOString(), actor, resource, structural,
                policyArtifactUuid: policy.artifactUuid });
            const validation = await this.provider.validate({ dataTurtle: evidence.turtle, shapesTurtle: policy.turtle,
                inference: "none", advanced: true, metaShacl: true, timeoutMs: 30000, correlationId });
            const technicalGap = actor.status === "indeterminate" || resource.status === "indeterminate"
                || structural.status === "missing" || structural.status === "indeterminate";
            const outcome = technicalGap ? "indeterminate" : validation.conforms ? "eligible" : "not_eligible";
            const evidenceGraphUri = reservationEvidenceGraphUri(graphConfig.config.baseUri, runUuid);
            const reportGraphUri = reservationPolicyReportGraphUri(graphConfig.config.baseUri, runUuid);
            await this.putImmutable(evidenceGraphUri, evidence.turtle);
            await this.putImmutable(reportGraphUri, validation.reportTurtle);
            const conflicts: SemanticEvidenceResponse["availability"]["conflicts"] = [];
            if (approvedConflict) conflicts.push({ kind: "asset_blocking_state", message: "An approved, in-use or no-show reservation overlaps this interval." });
            if (actorConflict) conflicts.push({ kind: "actor_overlap", message: "This actor already has a pending or approved reservation for the asset in this interval." });
            console.log(JSON.stringify({ type: "sql_availability_checked", correlationId, runUuid, assetId,
                authority: "sql", status: conflicts.length ? "conflict" : "available", conflictCount: conflicts.length, at: this.now().toISOString() }));
            const expiresAt = new Date(new Date(createdAt).getTime() + this.config.maxAgeSeconds * 1000).toISOString();
            const response: SemanticEvidenceResponse = {
                runUuid, inputs: { actorKey: normalized.original, assetId, assetUuid: resource.assetUuid,
                    start: start.toISOString(), end: end.toISOString() },
                actorEvidence: actor, resourceEvidence: resource, structuralEvidence: structural,
                semanticEligibility: { mode: "shadow", outcome, policyFilename: policy.filename,
                    policyVersion: policy.version, policyHash: policy.sha256, constraints: validation.constraints,
                    findings: validation.results },
                availability: { authority: "sql", status: conflicts.length ? "conflict" : "available", conflicts },
                evidenceGraph: { uri: evidenceGraphUri, sha256: evidence.sha256 },
                policyReportGraph: { uri: reportGraphUri, sha256: validation.reportSha256 },
                operationalEffect: { reservationCreated: false, semanticResultWasBinding: false },
                createdAt, expiresAt,
                caveats: ["actor_key_is_not_authenticated", "semantic_eligibility_is_shadow_only",
                    "sql_remains_availability_authority", "no_authorization_or_approval_decision"],
            };
            await this.database.persistCompleted({ ...response, actorKeyNormalized: normalized.normalized,
                actorLinkId: actor.linkId, institutionalArtifactId: actor.institutionalArtifactId,
                policyArtifactId: policy.artifactId,
                ...(raw.applicationIdentity ? { applicationIdentity: raw.applicationIdentity } : {}) });
            console.log(JSON.stringify({ type: "semantic_evidence_completed", correlationId, runUuid,
                actorReference: actorReference(normalized.original), assetUuid: resource.assetUuid,
                shadowOutcome: outcome, sqlAvailability: response.availability.status,
                resultCount: validation.resultCount, durationMs: Date.now() - started, at: this.now().toISOString() }));
            return response;
        } catch (error) {
            console.error(JSON.stringify({ type: "semantic_evidence_failed", correlationId, runUuid,
                actorReference: actorReference(normalized.original), assetId, errorCode: error instanceof SemanticEvidenceError ? error.code : "semantic_evidence_failed",
                durationMs: Date.now() - started, at: this.now().toISOString() }));
            throw error;
        }
    }

    async getRun(runUuid: string) {
        if (!/^[0-9a-f-]{36}$/i.test(runUuid)) throw new SemanticEvidenceError("invalid_run_uuid", "Invalid evidence run UUID.");
        const run = await this.database.getRun(runUuid);
        if (!run) throw new SemanticEvidenceError("evidence_run_not_found", "Evidence run was not found.", 404);
        return run;
    }

    async graphTurtle(runUuid: string, kind: "evidence" | "report"): Promise<string> {
        const run = await this.getRun(runUuid);
        if (!this.graph.getGraph) throw new SemanticEvidenceError("graph_download_unavailable", "Graph download is unavailable.", 503);
        const uri = kind === "evidence" ? run.response.evidenceGraph.uri : run.response.policyReportGraph.uri;
        return this.graph.getGraph(uri);
    }

    async assertMatchesAndLink(input: { runUuid: string; actorKey: string; assetId: number; start: Date; end: Date; reservationId?: number; applicationAccountId?: number }) {
        const run = await this.getRun(input.runUuid);
        const normalized = normalizeActorKey(input.actorKey);
        const mismatch = run.row.actor_key_normalized !== normalized.normalized || Number(run.row.asset_id) !== input.assetId
            || new Date(run.row.requested_start).getTime() !== input.start.getTime()
            || new Date(run.row.requested_end).getTime() !== input.end.getTime()
            || (input.applicationAccountId !== undefined && Number(run.row.application_account_id) !== input.applicationAccountId);
        if (mismatch) {
            console.warn(JSON.stringify({ type: "reservation_evidence_mismatch", runUuid: input.runUuid,
                actorReference: actorReference(normalized.original), assetId: input.assetId, at: this.now().toISOString() }));
            throw new SemanticEvidenceError("reservation_evidence_mismatch", "Evidence inputs do not match the reservation request.", 409);
        }
        if (new Date(run.row.expires_at).getTime() <= this.now().getTime()) {
            throw new SemanticEvidenceError("reservation_evidence_expired", "Evidence run has expired; check evidence again.", 409);
        }
        if (input.reservationId !== undefined) {
            await this.database.linkReservation(run.id, input.reservationId, run.response.evidenceGraph.sha256);
            console.log(JSON.stringify({ type: "reservation_evidence_linked", runUuid: input.runUuid,
                reservationId: input.reservationId, snapshotHash: run.response.evidenceGraph.sha256, at: this.now().toISOString() }));
        }
        return run;
    }

    private async resolveActor(actorKey: string, correlationId: string): Promise<ActorEvidenceView> {
        try {
            const context = await this.institutional.getActorContext(actorKey, correlationId);
            return { status: context.contextAvailable ? "available" : "unavailable", reason: context.unavailableReason,
                linkId: context.link.linkId ?? null, linkUuid: context.link.linkUuid, linkStatus: context.link.status,
                agentUri: context.person?.uri ?? null, organizations: uniqueOrganizations(context),
                roles: context.roles.map((role) => ({ ...role, allowed: ALLOWED_ROLES.has(role.uri) })),
                institutionalArtifactId: context.artifactContext?.dataset.artifactId ?? context.link.institutionalDatasetArtifactId ?? null,
                institutionalArtifactUuid: context.artifactContext?.dataset.artifactUuid ?? null,
                institutionalVersion: context.artifactContext?.dataset.semanticVersion ?? null,
                datasetCurrent: context.unavailableReason === "actor_link_requires_reverification" ? false
                    : context.artifactContext ? true : null };
        } catch (error) {
            const technical = error instanceof ActorInstitutionalLinkError
                && new Set(["institutional_graph_unavailable", "institutional_graph_timeout", "institutional_response_invalid"]).has(error.code);
            return { status: technical ? "indeterminate" : "unavailable",
                reason: error instanceof ActorInstitutionalLinkError ? error.code : "institutional_graph_unavailable",
                linkId: null, linkUuid: null, linkStatus: "unavailable", agentUri: null,
                organizations: [], roles: [], institutionalArtifactId: null, institutionalArtifactUuid: null,
                institutionalVersion: null, datasetCurrent: null };
        }
    }

    private async resolveResource(assetId: number, baseUri: string): Promise<{
        resource: ResourceEvidenceView; structural: StructuralEvidenceView;
    }> {
        try {
            const row = await this.database.resolveResource(assetId);
            if (!row) return { resource: { status: "unavailable", reason: "persistent_asset_not_found", assetId, assetUuid: null,
                assetUri: null, tag: null, location: null, modelVersionId: null, modelVersionUuid: null,
                modelVersionUri: null, materialisationId: null, materialisationUuid: null, graphUri: null,
                manifestationGuid: null, manifestationUri: null }, structural: {
                    status: "missing", validationRunId: null, validationRunUuid: null, shapesArtifactId: null, shapesVersion: null,
                } };
            const base = baseUri.replace(/\/+$/, "");
            const complete = Boolean(row.asset_uuid && row.tag && row.version_uuid && row.materialisation_uuid && row.ifc_guid);
            const resource: ResourceEvidenceView = { status: complete ? "available" : "unavailable", reason: complete ? null : "current_model_semantic_context_missing",
                assetId, assetUuid: row.asset_uuid, assetUri: row.asset_uuid ? `${base}/asset/${row.asset_uuid}` : null,
                tag: row.tag, location: row.location, modelVersionId: row.model_version_id,
                modelVersionUuid: row.version_uuid, modelVersionUri: row.version_uuid ? `${base}/model-version/${row.version_uuid}` : null,
                materialisationId: row.materialisation_id, materialisationUuid: row.materialisation_uuid, graphUri: row.named_graph_uri,
                manifestationGuid: row.ifc_guid, manifestationUri: row.version_uuid && row.ifc_guid
                    ? `${base}/model-version/${row.version_uuid}/manifestation/${encodeURIComponent(row.ifc_guid)}` : null };
            const structural: StructuralEvidenceView = row.structural_validation_run_uuid
                ? { status: Boolean(row.structural_conforms) ? "conforms" : "nonconformant",
                    validationRunId: row.structural_validation_run_id, validationRunUuid: row.structural_validation_run_uuid,
                    shapesArtifactId: row.shapes_artifact_id, shapesVersion: row.shapes_version }
                : { status: "missing", validationRunId: null, validationRunUuid: null, shapesArtifactId: null, shapesVersion: null };
            return { resource, structural };
        } catch {
            return { resource: { status: "indeterminate", reason: "resource_evidence_query_failed", assetId, assetUuid: null,
                assetUri: null, tag: null, location: null, modelVersionId: null, modelVersionUuid: null,
                modelVersionUri: null, materialisationId: null, materialisationUuid: null, graphUri: null,
                manifestationGuid: null, manifestationUri: null }, structural: {
                    status: "indeterminate", validationRunId: null, validationRunUuid: null, shapesArtifactId: null, shapesVersion: null,
                } };
        }
    }

    private async putImmutable(graphUri: string, turtle: string): Promise<void> {
        const exists = await this.graph.query(`ASK { GRAPH <${graphUri}> { ?s ?p ?o } }`);
        if (exists.boolean === true) throw new SemanticEvidenceError("immutable_evidence_graph_exists", "Evidence graph already exists.", 409);
        await this.graph.putGraph(graphUri, turtle, "text/turtle");
    }
}
