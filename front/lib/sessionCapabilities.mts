// Client-side view of the server-resolved session authorization contract.
// Capabilities are the authority for navigation and page guards; applicationArea
// is only a temporary compatibility alias and must not gate anything here.

export type Capabilities = {
  reserveResources: boolean;
  bimManagement: boolean;
  operationalManagement: boolean;
};

export type SessionInfo = {
  accountUuid?: string | null;
  accountKey?: string;
  displayLabel?: string;
  roles?: string[];
  capabilities?: Capabilities;
  applicationArea?: "manager" | "student";
};

export const noCapabilities: Capabilities = { reserveResources: false, bimManagement: false, operationalManagement: false };

export function capabilitiesOf(session: SessionInfo | null | undefined): Capabilities {
  return { ...noCapabilities, ...(session?.capabilities ?? {}) };
}

export function hasAnyManagement(capabilities: Capabilities): boolean {
  return capabilities.bimManagement || capabilities.operationalManagement;
}

export async function fetchSession(): Promise<{ ok: boolean; status: number; session: SessionInfo | null }> {
  const response = await fetch("/api/auth/session", { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, session: (payload?.data ?? null) as SessionInfo | null };
}
