import type { CurrentInstitutionalDataset } from "./actorInstitutionalLinkTypes.ts";

export interface InstitutionalRole { uri: string; label: string; }
export interface InstitutionalOrganization { uri: string; label: string; }
export interface InstitutionalMembership {
    membershipUri: string;
    organization: InstitutionalOrganization;
    roles: InstitutionalRole[];
}
export interface InstitutionalSupervisor { uri: string; label: string; }
export interface InstitutionalPerson {
    uri: string;
    label: string;
    studentNumber: string | null;
    types: string[];
}
export interface InstitutionalArtifactRevision {
    artifactId: number;
    artifactUuid: string;
    familyKey: string;
    semanticVersion: string;
    namedGraphUri: string;
}
export interface InstitutionalArtifactContext {
    ontology: InstitutionalArtifactRevision;
    dataset: InstitutionalArtifactRevision;
    bridge: InstitutionalArtifactRevision;
    ontologyVersion: string;
    datasetVersion: string;
    datasetArtifactUuid: string;
    datasetGraphUri: string;
    bridgeVersion: string;
}
export interface InstitutionalPersonContext {
    person: InstitutionalPerson;
    memberships: InstitutionalMembership[];
    roles: InstitutionalRole[];
    supervisors: InstitutionalSupervisor[];
}
export interface InstitutionalActorContext {
    actorKey: string;
    contextAvailable: boolean;
    unavailableReason: string | null;
    link: {
        linkId?: number;
        institutionalDatasetArtifactId?: number;
        linkUuid: string;
        status: string;
        linkType: string;
        validFrom: string | null;
        validTo: string | null;
        verifiedAt: string | null;
        verificationSource: string | null;
    };
    person: InstitutionalPerson | null;
    memberships: InstitutionalMembership[];
    roles: InstitutionalRole[];
    supervisors: InstitutionalSupervisor[];
    artifactContext: InstitutionalArtifactContext | null;
    caveats: string[];
}

export interface InstitutionalGraphProvider {
    findPersonByInstitutionalIdentifier(identifier: string): Promise<InstitutionalPerson | null>;
    getPersonByAgentUri(agentUri: string): Promise<InstitutionalPerson | null>;
    listMemberships(agentUri: string): Promise<InstitutionalMembership[]>;
    listRoles(agentUri: string): Promise<InstitutionalRole[]>;
    listSupervisors(agentUri: string): Promise<InstitutionalSupervisor[]>;
    listSuborganizations(organizationUri: string): Promise<InstitutionalOrganization[]>;
    listDoctoralStudents(organizationUri: string): Promise<InstitutionalPerson[]>;
    listSupervisingProfessors(): Promise<InstitutionalPerson[]>;
    listPeopleWithMultipleRoles(): Promise<InstitutionalPerson[]>;
    getInstitutionalArtifactContext(): Promise<InstitutionalArtifactContext>;
    getInstitutionalPersonContext(
        agentUri: string,
        artifactContext?: InstitutionalArtifactContext
    ): Promise<InstitutionalPersonContext | null>;
}

export interface InstitutionalArtifactResolver {
    resolve(): Promise<InstitutionalArtifactContext>;
    resolveCurrentInstitutionalDataset(): Promise<CurrentInstitutionalDataset>;
}

export interface InstitutionalLogger {
    info(event: string, details: Record<string, unknown>): void;
    error(event: string, details: Record<string, unknown>): void;
}

export const institutionalLogger: InstitutionalLogger = {
    info(event, details) { console.log(JSON.stringify({ type: "institutional_context", event, ...details, at: new Date().toISOString() })); },
    error(event, details) { console.error(JSON.stringify({ type: "institutional_context", event, ...details, at: new Date().toISOString() })); },
};
