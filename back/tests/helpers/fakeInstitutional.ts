import {
    ACTOR_LINK_TYPE,
    ActorInstitutionalLinkError,
    type ActorInstitutionalLinkRow,
    type CurrentInstitutionalDataset,
    type InstitutionalLinkVerifier,
} from "../../semantic/actorInstitutionalLinkTypes.ts";
import type { CreatePendingActorLinkInput, ActorInstitutionalLinkDatabasePort } from "../../utils/actorInstitutionalLinkDatabase.ts";
import type {
    InstitutionalArtifactContext,
    InstitutionalGraphProvider,
    InstitutionalMembership,
    InstitutionalOrganization,
    InstitutionalPerson,
    InstitutionalPersonContext,
    InstitutionalRole,
    InstitutionalSupervisor,
} from "../../semantic/institutionalTypes.ts";

export const TEST_DATASET: CurrentInstitutionalDataset = {
    artifactId: 40,
    artifactUuid: "00000000-0000-4000-8000-000000000040",
    semanticVersion: "1.1.0",
    namedGraphUri: "https://example.test/id/graph/institutional-data/synthetic/00000000-0000-4000-8000-000000000040",
    familyKey: "uminho-institutional-synthetic-data",
};

export const TEST_ARTIFACT_CONTEXT: InstitutionalArtifactContext = {
    ontology: { artifactId: 10, artifactUuid: "00000000-0000-4000-8000-000000000010", familyKey: "uminho-institutional-ontology", semanticVersion: "1.1.0", namedGraphUri: "https://example.test/id/graph/vocabularies/institutional-ontology/00000000-0000-4000-8000-000000000010" },
    dataset: { ...TEST_DATASET },
    bridge: { artifactId: 20, artifactUuid: "00000000-0000-4000-8000-000000000020", familyKey: "project-institutional-bridge", semanticVersion: "1.0.0", namedGraphUri: "https://example.test/id/graph/vocabularies/project-institutional-bridge/00000000-0000-4000-8000-000000000020" },
    ontologyVersion: "1.1.0",
    datasetVersion: "1.1.0",
    datasetArtifactUuid: TEST_DATASET.artifactUuid,
    datasetGraphUri: TEST_DATASET.namedGraphUri,
    bridgeVersion: "1.0.0",
};

export class FakeInstitutionalVerifier implements InstitutionalLinkVerifier {
    dataset = { ...TEST_DATASET };
    readonly agents = new Set<string>();
    resolveError: Error | null = null;

    async resolveCurrentInstitutionalDataset(): Promise<CurrentInstitutionalDataset> {
        if (this.resolveError) throw this.resolveError;
        return { ...this.dataset };
    }
    async agentExists(agentUri: string): Promise<boolean> { return this.agents.has(agentUri); }
}

export class FakeActorInstitutionalLinkDatabase implements ActorInstitutionalLinkDatabasePort {
    readonly rows: ActorInstitutionalLinkRow[] = [];
    artifactCurrent = true;
    private nextId = 1;
    private readonly lockTails = new Map<string, Promise<void>>();

    async withActorLock<T>(normalizedActorKey: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.lockTails.get(normalizedActorKey) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        this.lockTails.set(normalizedActorKey, previous.then(() => gate));
        await previous;
        try { return await fn(); } finally { release(); }
    }

    async createPending(input: CreatePendingActorLinkInput): Promise<ActorInstitutionalLinkRow> {
        const row: ActorInstitutionalLinkRow = {
            id: this.nextId++, link_uuid: input.linkUuid, actor_key: input.actorKey,
            actor_key_normalized: input.actorKeyNormalized, institutional_agent_uri: input.institutionalAgentUri,
            institutional_dataset_artifact_id: input.institutionalDatasetArtifactId, link_type: ACTOR_LINK_TYPE,
            status: "pending", valid_from: input.validFrom, valid_to: input.validTo,
            verified_at: null, verification_source: null, superseded_at: null, revoked_at: null,
            created_at: new Date(Date.UTC(2026, 6, 20, 0, 0, this.nextId)),
        };
        this.rows.push(row);
        return row;
    }
    async findByUuid(linkUuid: string) { return this.rows.find((row) => row.link_uuid === linkUuid) ?? null; }
    async findLatestForActor(key: string) { return [...this.rows].reverse().find((row) => row.actor_key_normalized === key) ?? null; }
    async findCurrentVerifiedForActor(key: string, now: Date) {
        return this.rows.find((row) => row.actor_key_normalized === key && row.status === "verified"
            && row.superseded_at === null && row.revoked_at === null
            && (row.valid_from === null || new Date(row.valid_from) <= now)
            && (row.valid_to === null || new Date(row.valid_to) >= now)) ?? null;
    }
    async findConvergent(input: CreatePendingActorLinkInput) {
        return this.rows.find((row) => row.actor_key_normalized === input.actorKeyNormalized
            && row.institutional_agent_uri === input.institutionalAgentUri
            && row.institutional_dataset_artifact_id === input.institutionalDatasetArtifactId
            && (row.status === "pending" || row.status === "verified")
            && row.superseded_at === null && row.revoked_at === null) ?? null;
    }
    async getHistory(key: string) { return [...this.rows].filter((row) => row.actor_key_normalized === key).reverse(); }
    async verifyPendingLink(linkUuid: string, source: string, at: Date) {
        const row = await this.findByUuid(linkUuid);
        if (!row) throw new ActorInstitutionalLinkError("actor_link_not_found", "not found", 404);
        if (!this.artifactCurrent) throw new ActorInstitutionalLinkError("institutional_artifact_not_active", "artifact not current");
        if (row.status === "verified") return row;
        if (row.status !== "pending") throw new ActorInstitutionalLinkError("actor_link_conflict", "not pending");
        const current = this.rows.find((candidate) => candidate.actor_key_normalized === row.actor_key_normalized && candidate.status === "verified" && candidate.superseded_at === null);
        if (current && current !== row) throw new ActorInstitutionalLinkError("actor_link_conflict", "different current");
        row.status = "verified"; row.verified_at = at; row.verification_source = source;
        return row;
    }
    async transition(linkUuid: string, status: "suspended" | "revoked" | "superseded", at: Date) {
        const row = await this.findByUuid(linkUuid);
        if (!row) throw new ActorInstitutionalLinkError("actor_link_not_found", "not found", 404);
        row.status = status;
        if (status === "revoked") row.revoked_at = at;
        if (status === "superseded") row.superseded_at = at;
        return row;
    }
}

const STUDENT1 = "https://example.org/uminho-phd/test/institutional/TestStudentPhD001";
const STUDENT2 = "https://example.org/uminho-phd/test/institutional/TestStudentPhD002";
const PROFESSOR1 = "https://example.org/uminho-phd/test/institutional/TestProfessor001";

export class FakeInstitutionalGraphProvider implements InstitutionalGraphProvider {
    artifactContext = structuredClone(TEST_ARTIFACT_CONTEXT);
    calls: string[] = [];
    unavailable: Error | null = null;
    readonly people = new Map<string, InstitutionalPerson>([
        [STUDENT1, { uri: STUDENT1, label: "TEST Student PhD 001", studentNumber: "TEST-STUDENT-001", types: ["urn:DoctoralStudent"] }],
        [STUDENT2, { uri: STUDENT2, label: "TEST Student PhD 002", studentNumber: "TEST-STUDENT-002", types: ["urn:DoctoralStudent"] }],
        [PROFESSOR1, { uri: PROFESSOR1, label: "TEST Professor 001", studentNumber: null, types: ["urn:Professor"] }],
    ]);

    private check(operation: string) { this.calls.push(operation); if (this.unavailable) throw this.unavailable; }
    async findPersonByInstitutionalIdentifier(identifier: string) { this.check("find_identifier"); return [...this.people.values()].find((p) => p.studentNumber === identifier) ?? null; }
    async getPersonByAgentUri(uri: string) { this.check("person"); return this.people.get(uri) ?? null; }
    async listMemberships(uri: string): Promise<InstitutionalMembership[]> {
        this.check("memberships");
        if (uri === STUDENT1) return [{ membershipUri: "urn:membership:1", organization: { uri: "urn:group:1", label: "TEST Research Group 001" }, roles: [{ uri: "urn:DoctoralStudentRole", label: "Doctoral student role" }, { uri: "urn:ResearchGroupMemberRole", label: "Research group member role" }] }];
        if (uri === STUDENT2) return [{ membershipUri: "urn:membership:2", organization: { uri: "urn:cluster:1", label: "TEST Research Cluster 001" }, roles: [{ uri: "urn:DoctoralStudentRole", label: "Doctoral student role" }, { uri: "urn:ResearchClusterMemberRole", label: "Research cluster member role" }] }];
        return [];
    }
    async listRoles(uri: string): Promise<InstitutionalRole[]> { return (await this.listMemberships(uri)).flatMap((membership) => membership.roles); }
    async listSupervisors(uri: string): Promise<InstitutionalSupervisor[]> { this.check("supervisors"); return uri === STUDENT1 ? [{ uri: PROFESSOR1, label: "TEST Professor 001" }] : []; }
    async listSuborganizations(): Promise<InstitutionalOrganization[]> { this.check("suborganizations"); return [{ uri: "urn:group:1", label: "TEST Research Group 001" }]; }
    async listDoctoralStudents(): Promise<InstitutionalPerson[]> { this.check("doctoral_students"); return [this.people.get(STUDENT1)!]; }
    async listSupervisingProfessors(): Promise<InstitutionalPerson[]> { this.check("supervising_professors"); return [this.people.get(PROFESSOR1)!]; }
    async listPeopleWithMultipleRoles(): Promise<InstitutionalPerson[]> { this.check("multiple_roles"); return [this.people.get(STUDENT1)!]; }
    async getInstitutionalArtifactContext() { this.check("artifacts"); return this.artifactContext; }
    async getInstitutionalPersonContext(uri: string): Promise<InstitutionalPersonContext | null> {
        const person = await this.getPersonByAgentUri(uri); if (!person) return null;
        const [memberships, roles, supervisors] = await Promise.all([this.listMemberships(uri), this.listRoles(uri), this.listSupervisors(uri)]);
        return { person, memberships, roles, supervisors };
    }
}

export function uuidSequence() {
    let n = 100;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}
