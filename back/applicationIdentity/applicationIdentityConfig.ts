export type ApplicationIdentityMode = "disabled" | "local_session";
export interface ApplicationIdentityConfig { enabled: boolean; mode: ApplicationIdentityMode; cookieName: string; ttlSeconds: number; localLoginEnabled: boolean; production: boolean; }

export function loadApplicationIdentityConfig(env: NodeJS.ProcessEnv = process.env): ApplicationIdentityConfig {
  const enabled = env.APPLICATION_IDENTITY_ENABLED === "true";
  const raw = (env.APPLICATION_IDENTITY_MODE ?? "disabled").trim();
  if (raw !== "disabled" && raw !== "local_session") throw new Error("APPLICATION_IDENTITY_MODE must be disabled or local_session.");
  const mode = raw as ApplicationIdentityMode;
  const production = env.NODE_ENV === "production";
  if (production && mode === "local_session") throw new Error("Local synthetic sessions are refused in production.");
  return { enabled, mode: enabled ? mode : "disabled", cookieName: env.APPLICATION_SESSION_COOKIE_NAME ?? "oswadt_local_session",
    ttlSeconds: Math.max(60, Number(env.APPLICATION_SESSION_TTL_SECONDS ?? 3600)), localLoginEnabled: env.LOCAL_SYNTHETIC_LOGIN_ENABLED === "true", production };
}
