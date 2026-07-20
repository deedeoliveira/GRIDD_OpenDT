export interface DemoActor { actorKey: string; scenario: "complete_context" | "no_supervisor_assertion" | "revoked_link"; }
export interface InstitutionalRole { uri: string; label: string; }
export interface InstitutionalContext {
  actorKey: string;
  contextAvailable: boolean;
  unavailableReason: string | null;
  link: { status: string; linkType: string; verifiedAt: string | null; verificationSource: string | null; };
  person: { uri: string; label: string; studentNumber: string | null; types: string[] } | null;
  memberships: Array<{
    membershipUri: string;
    organization: { uri: string; label: string };
    roles: InstitutionalRole[];
  }>;
  roles: InstitutionalRole[];
  supervisors: Array<{ uri: string; label: string }>;
  artifactContext: null | {
    ontologyVersion: string;
    datasetVersion: string;
    datasetArtifactUuid: string;
    bridgeVersion: string;
  };
  caveats: string[];
}

export interface ApiEnvelope<T> { ok: boolean; data?: T; code?: string; message?: string; }
