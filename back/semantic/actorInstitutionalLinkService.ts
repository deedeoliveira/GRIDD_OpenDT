import crypto from "node:crypto";
import type { ActorInstitutionalLinkDatabasePort } from "../utils/actorInstitutionalLinkDatabase.ts";
import {
    ACTOR_LINK_TYPE,
    ActorInstitutionalLinkError,
    normalizeActorKey,
    validateInstitutionalAgentUri,
    type ActorInstitutionalLinkRow,
    type InstitutionalLinkVerifier,
} from "./actorInstitutionalLinkTypes.ts";

export interface ActorLinkRuntime {
    newUuid(): string;
    now(): Date;
}

export class ActorInstitutionalLinkService {
    constructor(
        private readonly database: ActorInstitutionalLinkDatabasePort,
        private readonly verifier: InstitutionalLinkVerifier,
        private readonly runtime: ActorLinkRuntime = { newUuid: () => crypto.randomUUID(), now: () => new Date() }
    ) {}

    async createPendingLink(input: {
        actorKey: string;
        institutionalAgentUri: string;
        validFrom?: Date | null;
        validTo?: Date | null;
    }): Promise<ActorInstitutionalLinkRow> {
        const actor = normalizeActorKey(input.actorKey);
        const agentUri = validateInstitutionalAgentUri(input.institutionalAgentUri);
        const dataset = await this.verifier.resolveCurrentInstitutionalDataset();
        const validFrom = input.validFrom ?? null;
        const validTo = input.validTo ?? null;
        if (validFrom && validTo && validTo <= validFrom) {
            throw new ActorInstitutionalLinkError("actor_link_conflict", "validTo must be after validFrom", 400);
        }
        return this.database.withActorLock(actor.normalized, async () => {
            const proposed = {
                linkUuid: this.runtime.newUuid(),
                actorKey: actor.original,
                actorKeyNormalized: actor.normalized,
                institutionalAgentUri: agentUri,
                institutionalDatasetArtifactId: dataset.artifactId,
                validFrom,
                validTo,
            };
            const convergent = await this.database.findConvergent(proposed);
            if (convergent) return convergent;
            const latest = await this.database.findLatestForActor(actor.normalized);
            if (latest && (latest.status === "pending" || latest.status === "verified")) {
                throw new ActorInstitutionalLinkError("actor_link_conflict", "actor already has a divergent pending or verified institutional link");
            }
            return this.database.createPending(proposed);
        });
    }

    async verifyLink(linkUuid: string, verificationSource: string): Promise<ActorInstitutionalLinkRow> {
        const link = await this.database.findByUuid(linkUuid);
        if (!link) throw new ActorInstitutionalLinkError("actor_link_not_found", `actor link '${linkUuid}' was not found`, 404);
        if (link.status === "verified") return link;
        const dataset = await this.verifier.resolveCurrentInstitutionalDataset();
        if (dataset.artifactId !== Number(link.institutional_dataset_artifact_id)) {
            throw new ActorInstitutionalLinkError("actor_link_requires_reverification", "link dataset revision is no longer current");
        }
        if (!await this.verifier.agentExists(link.institutional_agent_uri, dataset)) {
            throw new ActorInstitutionalLinkError("institutional_agent_not_found", "institutional agent is absent from the active synthetic dataset", 404);
        }
        return this.database.withActorLock(link.actor_key_normalized, () =>
            this.database.verifyPendingLink(linkUuid, verificationSource.slice(0, 100), this.runtime.now())
        );
    }

    async createVerifiedLink(input: {
        actorKey: string;
        institutionalAgentUri: string;
        verificationSource: string;
    }): Promise<ActorInstitutionalLinkRow> {
        const pending = await this.createPendingLink(input);
        return pending.status === "verified" ? pending : this.verifyLink(pending.link_uuid, input.verificationSource);
    }

    async getCurrentLinkForActor(actorKey: string): Promise<ActorInstitutionalLinkRow | null> {
        const actor = normalizeActorKey(actorKey);
        return this.database.findCurrentVerifiedForActor(actor.normalized, this.runtime.now());
    }

    async getLatestLinkForActor(actorKey: string): Promise<ActorInstitutionalLinkRow | null> {
        return this.database.findLatestForActor(normalizeActorKey(actorKey).normalized);
    }

    async getLinkHistory(actorKey: string): Promise<ActorInstitutionalLinkRow[]> {
        return this.database.getHistory(normalizeActorKey(actorKey).normalized);
    }

    async suspendLink(linkUuid: string): Promise<ActorInstitutionalLinkRow> {
        return this.transition(linkUuid, "suspended");
    }

    async revokeLink(linkUuid: string): Promise<ActorInstitutionalLinkRow> {
        return this.transition(linkUuid, "revoked");
    }

    async supersedeCurrentLink(linkUuid: string): Promise<ActorInstitutionalLinkRow> {
        return this.transition(linkUuid, "superseded");
    }

    private async transition(linkUuid: string, status: "suspended" | "revoked" | "superseded"): Promise<ActorInstitutionalLinkRow> {
        const link = await this.database.findByUuid(linkUuid);
        if (!link) throw new ActorInstitutionalLinkError("actor_link_not_found", `actor link '${linkUuid}' was not found`, 404);
        return this.database.withActorLock(link.actor_key_normalized, () => this.database.transition(linkUuid, status, this.runtime.now()));
    }
}

export { ACTOR_LINK_TYPE };
