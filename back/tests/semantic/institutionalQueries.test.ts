import assert from "node:assert/strict";
import test from "node:test";
import { GraphError, type GraphClient, type SparqlQueryResult } from "../../graph/graphTypes.ts";
import { ActorInstitutionalLinkError } from "../../semantic/actorInstitutionalLinkTypes.ts";
import { FusekiInstitutionalGraphProvider } from "../../semantic/fusekiInstitutionalGraphProvider.ts";
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
} from "../../semantic/institutionalQueries.ts";
import type { InstitutionalArtifactResolver } from "../../semantic/institutionalTypes.ts";
import { TEST_ARTIFACT_CONTEXT, TEST_DATASET } from "../helpers/fakeInstitutional.ts";

const STUDENT = "https://example.org/uminho-phd/test/institutional/TestStudentPhD001";
const GROUP = "https://example.org/uminho-phd/test/institutional/TestResearchGroup001";

const resolver: InstitutionalArtifactResolver = {
    resolve: async () => structuredClone(TEST_ARTIFACT_CONTEXT),
    resolveCurrentInstitutionalDataset: async () => ({ ...TEST_DATASET }),
};
const logger = { info() {}, error() {} };
const uri = (value: string) => ({ type: "uri" as const, value });
const lit = (value: string, language?: string) => ({ type: "literal" as const, value, ...(language ? { "xml:lang": language } : {}) });

class QueueGraphClient implements GraphClient {
    readonly providerId = "queue";
    readonly queries: string[] = [];
    readonly queue: Array<SparqlQueryResult<any> | Error> = [];
    async healthCheck() { return { ok: true, provider: "queue", queryEndpoint: "fake", durationMs: 0, errorCode: null, error: null }; }
    async query<T = any>(sparql: string): Promise<SparqlQueryResult<T>> {
        this.queries.push(sparql);
        const value = this.queue.shift() ?? { results: { bindings: [] } };
        if (value instanceof Error) throw value;
        return value;
    }
    async putGraph() { throw new Error("read-only provider"); }
    async update() { throw new Error("read-only provider"); }
    async deleteGraph() { throw new Error("read-only provider"); }
}

test("institutional query builders validate IRIs and bind only governed named graphs", () => {
    const builders = [
        personByAgentUriQuery(TEST_ARTIFACT_CONTEXT, STUDENT), membershipsQuery(TEST_ARTIFACT_CONTEXT, STUDENT),
        rolesQuery(TEST_ARTIFACT_CONTEXT, STUDENT), supervisorsQuery(TEST_ARTIFACT_CONTEXT, STUDENT),
        suborganizationsQuery(TEST_ARTIFACT_CONTEXT, GROUP), doctoralStudentsByOrganizationQuery(TEST_ARTIFACT_CONTEXT, GROUP),
        supervisingProfessorsQuery(TEST_ARTIFACT_CONTEXT), peopleWithMultipleRolesQuery(TEST_ARTIFACT_CONTEXT),
    ];
    for (const query of builders) {
        assert.match(query, /GRAPH <https:\/\/example\.test\/id\/graph\//);
        assert.doesNotMatch(query, /graph\/operational|graph\/test|current|latest/);
    }
    assert.throws(() => personByAgentUriQuery(TEST_ARTIFACT_CONTEXT, "x> } UNION { ?s ?p ?o"), GraphError);
});

test("student-number literal escapes quotes and prevents SPARQL injection", () => {
    const query = personByIdentifierQuery(TEST_ARTIFACT_CONTEXT, 'TEST-" } UNION { ?s ?p ?o } #');
    assert.match(query, /TEST-\\" \} UNION/);
    assert.equal((query.match(/UNION/g) ?? []).length, 1, "injection text remains inside one escaped literal, not a query clause");
    assert.match(query, /studentNumber> "TEST-/);
});

test("provider returns person by student number as a string and deduplicates types", async () => {
    const graph = new QueueGraphClient();
    graph.queue.push({ results: { bindings: [
        { person: uri(STUDENT), label: lit("Student EN", "en"), studentNumber: lit("001"), type: uri("urn:type:A") },
        { person: uri(STUDENT), label: lit("Estudante PT", "pt"), studentNumber: lit("001"), type: uri("urn:type:A") },
        { person: uri(STUDENT), name: lit("No language"), studentNumber: lit("001"), type: uri("urn:type:B") },
    ] } });
    const person = await new FusekiInstitutionalGraphProvider(graph, resolver, logger).findPersonByInstitutionalIdentifier("001");
    assert.equal(person?.label, "Estudante PT");
    assert.equal(person?.studentNumber, "001");
    assert.deepEqual(person?.types, ["urn:type:A", "urn:type:B"]);
});

test("label fallback order is Portuguese, English, untagged, then URI local name", async () => {
    const graph = new QueueGraphClient();
    graph.queue.push({ results: { bindings: [{ person: uri(STUDENT), type: uri("urn:type:A") }] } });
    const person = await new FusekiInstitutionalGraphProvider(graph, resolver, logger).getPersonByAgentUri(STUDENT);
    assert.equal(person?.label, "TestStudentPhD001");
});

test("membership rows are grouped and duplicate roles removed", async () => {
    const graph = new QueueGraphClient();
    const membership = "https://example.org/test/Membership1";
    const role = "https://example.org/test/DoctoralStudentRole";
    graph.queue.push({ results: { bindings: [
        { membership: uri(membership), organization: uri(GROUP), organizationPrefLabel: lit("Grupo PT", "pt"), role: uri(role), rolePrefLabel: lit("Doctoral student", "en") },
        { membership: uri(membership), organization: uri(GROUP), organizationPrefLabel: lit("Group EN", "en"), role: uri(role), rolePrefLabel: lit("Doutorando", "pt") },
    ] } });
    const result = await new FusekiInstitutionalGraphProvider(graph, resolver, logger).listMemberships(STUDENT);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.organization.label, "Grupo PT");
    assert.deepEqual(result[0]?.roles, [{ uri: role, label: "Doutorando" }]);
});

test("absence of supervisor is a valid empty result", async () => {
    const graph = new QueueGraphClient();
    graph.queue.push({ results: { bindings: [] } });
    assert.deepEqual(await new FusekiInstitutionalGraphProvider(graph, resolver, logger).listSupervisors(STUDENT), []);
});

test("aggregate person context reuses one already-validated artifact revision", async () => {
    const graph = new QueueGraphClient();
    graph.queue.push(
        { results: { bindings: [{ person: uri(STUDENT), label: lit("TEST Student PhD 001"), type: uri("urn:DoctoralStudent") }] } },
        { results: { bindings: [] } },
        { results: { bindings: [] } },
        { results: { bindings: [] } },
    );
    const rejectingResolver: InstitutionalArtifactResolver = {
        resolve: async () => { throw new Error("artifact context must not be resolved twice"); },
        resolveCurrentInstitutionalDataset: async () => ({ ...TEST_DATASET }),
    };
    const result = await new FusekiInstitutionalGraphProvider(graph, rejectingResolver, logger)
        .getInstitutionalPersonContext(STUDENT, TEST_ARTIFACT_CONTEXT);
    assert.equal(result?.person.uri, STUDENT);
    assert.equal(graph.queries.length, 4);
});

test("malformed SELECT response is rejected without exposing raw response", async () => {
    const graph = new QueueGraphClient();
    graph.queue.push({ boolean: true });
    await assert.rejects(new FusekiInstitutionalGraphProvider(graph, resolver, logger).getPersonByAgentUri(STUDENT),
        (error: unknown) => error instanceof ActorInstitutionalLinkError && error.code === "institutional_response_invalid");
});

test("graph timeout and unavailable errors map to controlled institutional errors", async () => {
    for (const [graphCode, expected, status] of [["graph_timeout", "institutional_graph_timeout", 504], ["graph_unavailable", "institutional_graph_unavailable", 503]] as const) {
        const graph = new QueueGraphClient();
        graph.queue.push(new GraphError(graphCode, "endpoint and query details must not escape"));
        await assert.rejects(new FusekiInstitutionalGraphProvider(graph, resolver, logger).getPersonByAgentUri(STUDENT),
            (error: unknown) => error instanceof ActorInstitutionalLinkError && error.code === expected && error.httpStatus === status && !error.message.includes("endpoint"));
    }
});

test("provider supports doctoral students, supervising professors, multiple roles and hierarchy queries", async () => {
    const graph = new QueueGraphClient();
    const provider = new FusekiInstitutionalGraphProvider(graph, resolver, logger);
    graph.queue.push({ results: { bindings: [{ person: uri(STUDENT), label: lit("TEST Student PhD 001"), type: uri("urn:DoctoralStudent") }] } });
    assert.equal((await provider.listDoctoralStudents(GROUP))[0]?.label, "TEST Student PhD 001");
    graph.queue.push({ results: { bindings: [{ person: uri("https://example.org/test/Professor"), label: lit("TEST Professor 001"), type: uri("urn:Professor") }] } });
    assert.equal((await provider.listSupervisingProfessors())[0]?.label, "TEST Professor 001");
    graph.queue.push({ results: { bindings: [{ person: uri(STUDENT), label: lit("TEST Student PhD 001"), type: uri("urn:DoctoralStudent") }] } });
    assert.equal((await provider.listPeopleWithMultipleRoles()).length, 1);
    graph.queue.push({ results: { bindings: [{ organization: uri(GROUP), prefLabel: lit("TEST Research Group 001", "pt") }] } });
    assert.equal((await provider.listSuborganizations("https://example.org/uminho-phd/test/institutional/TestSchool001"))[0]?.label, "TEST Research Group 001");
});
