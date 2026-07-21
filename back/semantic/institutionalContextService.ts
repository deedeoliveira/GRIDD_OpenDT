import crypto from "node:crypto";
import type { ActorInstitutionalLinkService } from "./actorInstitutionalLinkService.ts";
import { ActorInstitutionalLinkError, type ActorInstitutionalLinkRow } from "./actorInstitutionalLinkTypes.ts";
import type { InstitutionalActorContext, InstitutionalArtifactContext, InstitutionalGraphProvider, InstitutionalLogger } from "./institutionalTypes.ts";

const CAVEATS = [
    "synthetic_demo_data",
    "actor_key_is_not_authenticated",
    "not_an_eligibility_decision",
    "not_an_authorization_decision",
    "not_a_reservation_decision",
] as const;

function iso(value: Date | string | null): string | null {
    if (value === null) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export class InstitutionalContextService {
    constructor(
        private readonly links: ActorInstitutionalLinkService,
        private readonly graph: InstitutionalGraphProvider,
        private readonly logger: InstitutionalLogger,
        private readonly now: () => Date = () => new Date()
    ) {}

    async getActorContext(actorKey: string, correlationId: string = crypto.randomUUID()): Promise<InstitutionalActorContext> {
        const started = Date.now();
        const link = await this.links.getLatestLinkForActor(actorKey);
        if (!link) throw new ActorInstitutionalLinkError("actor_link_not_found", "institutional actor link was not found", 404);
        const actorReference = actorKey.startsWith("TEST-")
            ? actorKey
            : `sha256:${crypto.createHash("sha256").update(actorKey).digest("hex").slice(0, 16)}`;

        const unavailable = this.unavailableReason(link);
        if (unavailable) {
            this.logger.info("institutional_actor_link_unavailable", {
                correlationId, actorReference, linkUuid: link.link_uuid, reason: unavailable, durationMs: Date.now() - started,
            });
            return this.result(actorKey, link, unavailable, null);
        }

        const artifactContext = await this.graph.getInstitutionalArtifactContext();
        if (Number(link.institutional_dataset_artifact_id) !== artifactContext.dataset.artifactId) {
            const reason = "actor_link_requires_reverification";
            this.logger.info("institutional_actor_link_unavailable", {
                correlationId, actorReference, linkUuid: link.link_uuid,
                artifactUuid: artifactContext.dataset.artifactUuid, reason, durationMs: Date.now() - started,
            });
            return this.result(actorKey, link, reason, artifactContext);
        }

        this.logger.info("institutional_actor_link_resolved", {
            correlationId, actorReference, linkUuid: link.link_uuid, artifactUuid: artifactContext.dataset.artifactUuid,
        });
        const personContext = await this.graph.getInstitutionalPersonContext(
            link.institutional_agent_uri,
            artifactContext
        );
        if (!personContext) {
            throw new ActorInstitutionalLinkError("institutional_agent_not_found", "linked institutional agent is absent from the active graph", 404);
        }
        this.logger.info("institutional_context_query_completed", {
            correlationId, actorReference, linkUuid: link.link_uuid,
            artifactUuid: artifactContext.dataset.artifactUuid, durationMs: Date.now() - started,
            membershipCount: personContext.memberships.length, roleCount: personContext.roles.length,
            supervisorCount: personContext.supervisors.length,
        });
        return {
            actorKey,
            contextAvailable: true,
            unavailableReason: null,
            link: this.linkView(link),
            ...personContext,
            artifactContext,
            caveats: [...CAVEATS],
        };
    }

    private unavailableReason(link: ActorInstitutionalLinkRow): string | null {
        if (link.status === "pending") return "actor_link_not_verified";
        if (link.status === "suspended") return "actor_link_suspended";
        if (link.status === "revoked") return "actor_link_revoked";
        if (link.status === "superseded") return "actor_link_superseded";
        const now = this.now().getTime();
        const validFrom = iso(link.valid_from);
        const validTo = iso(link.valid_to);
        if (validFrom && new Date(validFrom).getTime() > now) return "actor_link_not_verified";
        if (validTo && new Date(validTo).getTime() < now) return "actor_link_expired";
        return null;
    }

    private result(
        actorKey: string,
        link: ActorInstitutionalLinkRow,
        reason: string,
        artifactContext: InstitutionalArtifactContext | null
    ): InstitutionalActorContext {
        return {
            actorKey,
            contextAvailable: false,
            unavailableReason: reason,
            link: this.linkView(link),
            person: null,
            memberships: [],
            roles: [],
            supervisors: [],
            artifactContext,
            caveats: [...CAVEATS],
        };
    }

    private linkView(link: ActorInstitutionalLinkRow): InstitutionalActorContext["link"] {
        return {
            linkId: Number(link.id),
            institutionalDatasetArtifactId: Number(link.institutional_dataset_artifact_id),
            linkUuid: link.link_uuid,
            status: link.status,
            linkType: link.link_type,
            validFrom: iso(link.valid_from),
            validTo: iso(link.valid_to),
            verifiedAt: iso(link.verified_at),
            verificationSource: link.verification_source,
        };
    }
}

export { CAVEATS as INSTITUTIONAL_CONTEXT_CAVEATS };
