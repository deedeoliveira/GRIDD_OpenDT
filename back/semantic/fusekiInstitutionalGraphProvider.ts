import crypto from "node:crypto";
import { GraphError, type GraphClient, type SparqlBindingValue } from "../graph/graphTypes.ts";
import { ActorInstitutionalLinkError } from "./actorInstitutionalLinkTypes.ts";
import {
    doctoralStudentsByOrganizationQuery,
    membershipsQuery,
    peopleWithMultipleRolesQuery,
    personByAgentUriQuery,
    personByIdentifierQuery,
    rolesQuery,
    suborganizationsQuery,
    supervisingProfessorsQuery,
    supervisorsQuery,
} from "./institutionalQueries.ts";
import type {
    InstitutionalArtifactContext,
    InstitutionalArtifactResolver,
    InstitutionalGraphProvider,
    InstitutionalLogger,
    InstitutionalMembership,
    InstitutionalOrganization,
    InstitutionalPerson,
    InstitutionalPersonContext,
    InstitutionalRole,
    InstitutionalSupervisor,
} from "./institutionalTypes.ts";

type BindingRow = Record<string, SparqlBindingValue>;

function localName(uri: string): string {
    const value = uri.split(/[\/#]/).filter(Boolean).at(-1) ?? uri;
    try { return decodeURIComponent(value); } catch { return value; }
}

function validUri(value: SparqlBindingValue | undefined): string | null {
    if (!value || value.type !== "uri") return null;
    try { return new URL(value.value).toString(); } catch { return null; }
}

function literal(value: SparqlBindingValue | undefined): string | null {
    return value?.type === "literal" ? value.value : null;
}

function labelRank(value: SparqlBindingValue): number {
    const language = value["xml:lang"]?.toLowerCase() ?? "";
    if (language === "pt" || language.startsWith("pt-")) return 0;
    if (language === "en" || language.startsWith("en-")) return 1;
    if (language === "") return 2;
    return 3;
}

function preferredLabel(rows: BindingRow[], keys: string[], fallbackUri: string): string {
    const values: SparqlBindingValue[] = [];
    for (const row of rows) for (const key of keys) {
        const value = row[key];
        if (value?.type === "literal" && value.value.trim()) values.push(value);
    }
    values.sort((a, b) => labelRank(a) - labelRank(b) || a.value.localeCompare(b.value));
    return values[0]?.value ?? localName(fallbackUri);
}

function unique<T>(values: T[]): T[] { return [...new Set(values)]; }

export class FusekiInstitutionalGraphProvider implements InstitutionalGraphProvider {
    constructor(
        private readonly graphClient: GraphClient,
        private readonly artifacts: InstitutionalArtifactResolver,
        private readonly logger: InstitutionalLogger,
        private readonly now: () => number = () => Date.now()
    ) {}

    async findPersonByInstitutionalIdentifier(identifier: string): Promise<InstitutionalPerson | null> {
        if (typeof identifier !== "string" || identifier.trim() === "" || identifier.length > 255) {
            throw new ActorInstitutionalLinkError("institutional_response_invalid", "institutional identifier is invalid", 400);
        }
        const context = await this.artifacts.resolve();
        return this.personFromRows(await this.query("person_by_identifier", personByIdentifierQuery(context, identifier)), null);
    }

    async getPersonByAgentUri(agentUri: string): Promise<InstitutionalPerson | null> {
        const context = await this.artifacts.resolve();
        return this.personFromRows(await this.query("person_by_agent", personByAgentUriQuery(context, agentUri)), agentUri);
    }

    async listMemberships(agentUri: string): Promise<InstitutionalMembership[]> {
        const context = await this.artifacts.resolve();
        const rows = await this.query("memberships", membershipsQuery(context, agentUri));
        return this.membershipsFromRows(rows);
    }

    private membershipsFromRows(rows: BindingRow[]): InstitutionalMembership[] {
        const groups = new Map<string, BindingRow[]>();
        for (const row of rows) {
            const membership = validUri(row.membership);
            const organization = validUri(row.organization);
            if (!membership || !organization) continue;
            const key = `${membership}\u0000${organization}`;
            groups.set(key, [...(groups.get(key) ?? []), row]);
        }
        return [...groups.entries()].map(([key, group]) => {
            const [membershipUri, organizationUri] = key.split("\u0000") as [string, string];
            const roles = new Map<string, BindingRow[]>();
            for (const row of group) {
                const role = validUri(row.role);
                if (role) roles.set(role, [...(roles.get(role) ?? []), row]);
            }
            return {
                membershipUri,
                organization: {
                    uri: organizationUri,
                    label: preferredLabel(group, ["organizationPrefLabel", "organizationLabel", "organizationName"], organizationUri),
                },
                roles: [...roles.entries()].map(([uri, roleRows]) => ({
                    uri,
                    label: preferredLabel(roleRows, ["rolePrefLabel", "roleLabel"], uri),
                })).sort((a, b) => a.label.localeCompare(b.label)),
            };
        }).sort((a, b) => a.organization.label.localeCompare(b.organization.label));
    }

    async listRoles(agentUri: string): Promise<InstitutionalRole[]> {
        const context = await this.artifacts.resolve();
        const rows = await this.query("roles", rolesQuery(context, agentUri));
        return this.rolesFromRows(rows);
    }

    private rolesFromRows(rows: BindingRow[]): InstitutionalRole[] {
        const grouped = new Map<string, BindingRow[]>();
        for (const row of rows) {
            const uri = validUri(row.role);
            if (uri) grouped.set(uri, [...(grouped.get(uri) ?? []), row]);
        }
        return [...grouped.entries()].map(([uri, group]) => ({
            uri,
            label: preferredLabel(group, ["rolePrefLabel", "roleLabel"], uri),
        })).sort((a, b) => a.label.localeCompare(b.label));
    }

    async listSupervisors(agentUri: string): Promise<InstitutionalSupervisor[]> {
        const context = await this.artifacts.resolve();
        const rows = await this.query("supervisors", supervisorsQuery(context, agentUri));
        return this.peopleLike(rows, "supervisor");
    }

    async listSuborganizations(organizationUri: string): Promise<InstitutionalOrganization[]> {
        const context = await this.artifacts.resolve();
        return this.peopleLike(await this.query("suborganizations", suborganizationsQuery(context, organizationUri)), "organization");
    }

    async listDoctoralStudents(organizationUri: string): Promise<InstitutionalPerson[]> {
        const context = await this.artifacts.resolve();
        return this.personList(await this.query("doctoral_students", doctoralStudentsByOrganizationQuery(context, organizationUri)));
    }

    async listSupervisingProfessors(): Promise<InstitutionalPerson[]> {
        const context = await this.artifacts.resolve();
        return this.personList(await this.query("supervising_professors", supervisingProfessorsQuery(context)));
    }

    async listPeopleWithMultipleRoles(): Promise<InstitutionalPerson[]> {
        const context = await this.artifacts.resolve();
        return this.personList(await this.query("people_multiple_roles", peopleWithMultipleRolesQuery(context)));
    }

    async getInstitutionalArtifactContext(): Promise<InstitutionalArtifactContext> {
        return this.artifacts.resolve();
    }

    async getInstitutionalPersonContext(
        agentUri: string,
        artifactContext?: InstitutionalArtifactContext
    ): Promise<InstitutionalPersonContext | null> {
        const context = artifactContext ?? await this.artifacts.resolve();
        const person = this.personFromRows(
            await this.query("person_by_agent", personByAgentUriQuery(context, agentUri)),
            agentUri
        );
        if (!person) return null;
        const [membershipRows, roleRows, supervisorRows] = await Promise.all([
            this.query("memberships", membershipsQuery(context, agentUri)),
            this.query("roles", rolesQuery(context, agentUri)),
            this.query("supervisors", supervisorsQuery(context, agentUri)),
        ]);
        const memberships = this.membershipsFromRows(membershipRows);
        const roles = this.rolesFromRows(roleRows);
        const supervisors = this.peopleLike(supervisorRows, "supervisor");
        return { person, memberships, roles, supervisors };
    }

    private personList(rows: BindingRow[]): InstitutionalPerson[] {
        const grouped = new Map<string, BindingRow[]>();
        for (const row of rows) {
            const uri = validUri(row.person);
            if (uri) grouped.set(uri, [...(grouped.get(uri) ?? []), row]);
        }
        return [...grouped.entries()].map(([uri, group]) => this.personFromRows(group, uri)!).sort((a, b) => a.label.localeCompare(b.label));
    }

    private personFromRows(rows: BindingRow[], fallbackUri: string | null): InstitutionalPerson | null {
        if (rows.length === 0) return null;
        const uri = validUri(rows[0]?.person) ?? fallbackUri;
        if (!uri) throw new ActorInstitutionalLinkError("institutional_response_invalid", "person query returned no valid URI", 503);
        return {
            uri,
            label: preferredLabel(rows, ["prefLabel", "label", "name"], uri),
            studentNumber: rows.map((row) => literal(row.studentNumber)).find((value) => value !== null) ?? null,
            types: unique(rows.map((row) => validUri(row.type)).filter((value): value is string => value !== null)).sort(),
        };
    }

    private peopleLike(rows: BindingRow[], uriKey: string): Array<{ uri: string; label: string }> {
        const grouped = new Map<string, BindingRow[]>();
        for (const row of rows) {
            const uri = validUri(row[uriKey]);
            if (uri) grouped.set(uri, [...(grouped.get(uri) ?? []), row]);
        }
        return [...grouped.entries()].map(([uri, group]) => ({
            uri,
            label: preferredLabel(group, ["prefLabel", "label", "name"], uri),
        })).sort((a, b) => a.label.localeCompare(b.label));
    }

    private async query(operation: string, sparql: string): Promise<BindingRow[]> {
        const correlationId = crypto.randomUUID();
        const started = this.now();
        this.logger.info("institutional_context_query_started", { correlationId, operation });
        try {
            const result = await this.graphClient.query<BindingRow>(sparql);
            if (!result.results || !Array.isArray(result.results.bindings)) {
                throw new ActorInstitutionalLinkError("institutional_response_invalid", "institutional graph returned an invalid SELECT response", 503);
            }
            this.logger.info("institutional_context_query_completed", {
                correlationId, operation, durationMs: this.now() - started, resultCount: result.results.bindings.length,
            });
            return result.results.bindings;
        } catch (error) {
            const mapped = this.mapGraphError(error);
            this.logger.error("institutional_context_query_failed", {
                correlationId, operation, durationMs: this.now() - started, errorCode: mapped.code,
            });
            throw mapped;
        }
    }

    private mapGraphError(error: unknown): ActorInstitutionalLinkError {
        if (error instanceof ActorInstitutionalLinkError) return error;
        if (error instanceof GraphError) {
            if (error.code === "graph_timeout") return new ActorInstitutionalLinkError("institutional_graph_timeout", "institutional graph request timed out", 504);
            if (error.code === "graph_invalid_response") return new ActorInstitutionalLinkError("institutional_response_invalid", "institutional graph returned an invalid response", 503);
            return new ActorInstitutionalLinkError("institutional_graph_unavailable", "institutional graph is unavailable", 503);
        }
        return new ActorInstitutionalLinkError("institutional_graph_unavailable", "institutional graph is unavailable", 503);
    }
}
