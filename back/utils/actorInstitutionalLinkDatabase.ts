import crypto from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import MySQLDatabase from "./mysqlDatabase.ts";
import {
    ACTOR_LINK_TYPE,
    ActorInstitutionalLinkError,
    type ActorInstitutionalLinkRow,
} from "../semantic/actorInstitutionalLinkTypes.ts";

export interface CreatePendingActorLinkInput {
    linkUuid: string;
    actorKey: string;
    actorKeyNormalized: string;
    institutionalAgentUri: string;
    institutionalDatasetArtifactId: number;
    validFrom: Date | null;
    validTo: Date | null;
}

export interface ActorInstitutionalLinkDatabasePort {
    withActorLock<T>(normalizedActorKey: string, fn: () => Promise<T>): Promise<T>;
    createPending(input: CreatePendingActorLinkInput): Promise<ActorInstitutionalLinkRow>;
    findByUuid(linkUuid: string): Promise<ActorInstitutionalLinkRow | null>;
    findLatestForActor(normalizedActorKey: string): Promise<ActorInstitutionalLinkRow | null>;
    findCurrentVerifiedForActor(normalizedActorKey: string, now: Date): Promise<ActorInstitutionalLinkRow | null>;
    findConvergent(input: CreatePendingActorLinkInput): Promise<ActorInstitutionalLinkRow | null>;
    getHistory(normalizedActorKey: string): Promise<ActorInstitutionalLinkRow[]>;
    verifyPendingLink(linkUuid: string, verificationSource: string, verifiedAt: Date): Promise<ActorInstitutionalLinkRow>;
    transition(linkUuid: string, status: "suspended" | "revoked" | "superseded", at: Date): Promise<ActorInstitutionalLinkRow>;
}

function requiredRow(rows: ActorInstitutionalLinkRow[], linkUuid: string): ActorInstitutionalLinkRow {
    const row = rows[0];
    if (!row) throw new ActorInstitutionalLinkError("actor_link_not_found", `actor link '${linkUuid}' was not found`, 404);
    return row;
}

export class ActorInstitutionalLinkDatabase implements ActorInstitutionalLinkDatabasePort {
    constructor(private readonly db: MySQLDatabase = new MySQLDatabase()) {
        void this.db.connect();
    }

    async withActorLock<T>(normalizedActorKey: string, fn: () => Promise<T>): Promise<T> {
        const digest = crypto.createHash("sha256").update(normalizedActorKey).digest("hex").slice(0, 40);
        // 58 characters: safely below MySQL's 64-character GET_LOCK limit.
        return this.db.withNamedLock(`oswadt.inst.actor.${digest}`, 30, fn);
    }

    async createPending(input: CreatePendingActorLinkInput): Promise<ActorInstitutionalLinkRow> {
        await this.db.checkConnection();
        await this.db.connection.execute(`
            INSERT INTO actor_institutional_links
                (link_uuid, actor_key, actor_key_normalized, institutional_agent_uri,
                 institutional_dataset_artifact_id, link_type, status, valid_from, valid_to)
            VALUES
                (:linkUuid, :actorKey, :actorKeyNormalized, :institutionalAgentUri,
                 :institutionalDatasetArtifactId, :linkType, 'pending', :validFrom, :validTo)
        `, { ...input, linkType: ACTOR_LINK_TYPE });
        return (await this.findByUuid(input.linkUuid))!;
    }

    async findByUuid(linkUuid: string): Promise<ActorInstitutionalLinkRow | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(
            "SELECT * FROM actor_institutional_links WHERE link_uuid = :linkUuid LIMIT 1",
            { linkUuid }
        );
        return rows[0] ?? null;
    }

    async findLatestForActor(normalizedActorKey: string): Promise<ActorInstitutionalLinkRow | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT * FROM actor_institutional_links
            WHERE actor_key_normalized = :normalizedActorKey AND link_type = :linkType
            ORDER BY created_at DESC, id DESC LIMIT 1
        `, { normalizedActorKey, linkType: ACTOR_LINK_TYPE });
        return rows[0] ?? null;
    }

    async findCurrentVerifiedForActor(normalizedActorKey: string, now: Date): Promise<ActorInstitutionalLinkRow | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT * FROM actor_institutional_links
            WHERE actor_key_normalized = :normalizedActorKey
              AND link_type = :linkType AND status = 'verified'
              AND superseded_at IS NULL AND revoked_at IS NULL
              AND (valid_from IS NULL OR valid_from <= :now)
              AND (valid_to IS NULL OR valid_to >= :now)
            ORDER BY verified_at DESC, id DESC LIMIT 1
        `, { normalizedActorKey, linkType: ACTOR_LINK_TYPE, now });
        return rows[0] ?? null;
    }

    async findConvergent(input: CreatePendingActorLinkInput): Promise<ActorInstitutionalLinkRow | null> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT * FROM actor_institutional_links
            WHERE actor_key_normalized = :actorKeyNormalized
              AND link_type = :linkType
              AND institutional_agent_uri = :institutionalAgentUri
              AND institutional_dataset_artifact_id = :institutionalDatasetArtifactId
              AND status IN ('pending','verified')
              AND superseded_at IS NULL AND revoked_at IS NULL
            ORDER BY created_at DESC, id DESC LIMIT 1
        `, { ...input, linkType: ACTOR_LINK_TYPE });
        return rows[0] ?? null;
    }

    async getHistory(normalizedActorKey: string): Promise<ActorInstitutionalLinkRow[]> {
        await this.db.checkConnection();
        const [rows]: any = await this.db.connection.execute(`
            SELECT * FROM actor_institutional_links
            WHERE actor_key_normalized = :normalizedActorKey AND link_type = :linkType
            ORDER BY created_at DESC, id DESC
        `, { normalizedActorKey, linkType: ACTOR_LINK_TYPE });
        return rows;
    }

    async verifyPendingLink(linkUuid: string, verificationSource: string, verifiedAt: Date): Promise<ActorInstitutionalLinkRow> {
        return this.db.withTransaction(async (conn) => {
            const link = await this.lockLink(conn, linkUuid);
            if (link.status === "verified") return link;
            if (link.status !== "pending") {
                throw new ActorInstitutionalLinkError("actor_link_conflict", `link in status '${link.status}' cannot be verified`);
            }
            const [artifactRows]: any = await conn.execute(`
                SELECT a.id, a.lifecycle_status, a.validation_status, f.current_artifact_id, f.artifact_type
                FROM semantic_artifacts a
                JOIN semantic_artifact_families f ON f.id = a.family_id
                WHERE a.id = :artifactId
                LIMIT 1 FOR UPDATE
            `, { artifactId: link.institutional_dataset_artifact_id });
            const artifact = artifactRows[0];
            if (!artifact || artifact.artifact_type !== "institutional_dataset"
                || artifact.lifecycle_status !== "active" || artifact.validation_status !== "graph_verified"
                || Number(artifact.current_artifact_id) !== Number(artifact.id)) {
                throw new ActorInstitutionalLinkError("institutional_artifact_not_active", "institutional dataset artifact is not current and graph-verified");
            }
            const [currentRows]: any = await conn.execute(`
                SELECT * FROM actor_institutional_links
                WHERE actor_key_normalized = :actorKeyNormalized
                  AND link_type = :linkType AND status = 'verified'
                  AND superseded_at IS NULL AND revoked_at IS NULL
                LIMIT 1 FOR UPDATE
            `, { actorKeyNormalized: link.actor_key_normalized, linkType: ACTOR_LINK_TYPE });
            const current = currentRows[0] as ActorInstitutionalLinkRow | undefined;
            if (current && current.link_uuid !== link.link_uuid) {
                throw new ActorInstitutionalLinkError("actor_link_conflict", "a different current verified actor link already exists");
            }
            await conn.execute(`
                UPDATE actor_institutional_links
                SET status = 'verified', verified_at = :verifiedAt,
                    verification_source = :verificationSource
                WHERE link_uuid = :linkUuid AND status = 'pending'
            `, { linkUuid, verificationSource, verifiedAt });
            return { ...link, status: "verified", verified_at: verifiedAt, verification_source: verificationSource };
        });
    }

    async transition(linkUuid: string, status: "suspended" | "revoked" | "superseded", at: Date): Promise<ActorInstitutionalLinkRow> {
        return this.db.withTransaction(async (conn) => {
            const link = await this.lockLink(conn, linkUuid);
            if (link.status === status) return link;
            const revokedAt = status === "revoked" ? at : link.revoked_at;
            const supersededAt = status === "superseded" ? at : link.superseded_at;
            await conn.execute(`
                UPDATE actor_institutional_links
                SET status = :status, revoked_at = :revokedAt, superseded_at = :supersededAt
                WHERE link_uuid = :linkUuid
            `, { linkUuid, status, revokedAt, supersededAt });
            return { ...link, status, revoked_at: revokedAt, superseded_at: supersededAt };
        });
    }

    private async lockLink(conn: PoolConnection, linkUuid: string): Promise<ActorInstitutionalLinkRow> {
        const [rows]: any = await conn.execute(
            "SELECT * FROM actor_institutional_links WHERE link_uuid = :linkUuid LIMIT 1 FOR UPDATE",
            { linkUuid }
        );
        return requiredRow(rows, linkUuid);
    }
}
