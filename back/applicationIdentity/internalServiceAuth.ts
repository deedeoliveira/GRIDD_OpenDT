import crypto from "node:crypto";
import type { Request } from "express";

/**
 * Internal service-to-service authentication for the model-file download boundary.
 *
 * The Python IFC-extraction microservice downloads a promoted model file from Node
 * via a server-to-server GET (it does not run in a browser and holds no application
 * session), so it cannot satisfy the reserveResources capability guard. Instead it
 * presents a shared internal-service token in a dedicated header, compared in
 * constant time against a value supplied ONLY through environment configuration.
 *
 * This credential is a NARROW, opt-in second authorization path: it is consulted
 * ONLY by the specific internal file-download operation that wires it in (see
 * routes/model.ts). It is never registered as global middleware and never granted
 * capabilities, so it can never authorize any capability-guarded route. The existing
 * session/capability path is left fully intact for browser users.
 *
 * The token is read from the environment and compared, but is NEVER logged, returned
 * in an API body, or embedded in any error message.
 */

/** Dedicated header carrying the internal-service token (lower-cased for Node header lookup). */
export const INTERNAL_SERVICE_TOKEN_HEADER = "x-oswadt-internal-service-token";
/** Environment variable that configures the shared internal-service token. */
export const INTERNAL_SERVICE_TOKEN_ENV = "OSWADT_INTERNAL_SERVICE_TOKEN";

/**
 * The configured internal-service token, or null when the variable is unset or empty
 * (an empty/whitespace-only value never authorizes anything). Never logged.
 */
export function configuredInternalServiceToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[INTERNAL_SERVICE_TOKEN_ENV];
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

/**
 * Constant-time comparison of two secrets that never throws on unequal lengths.
 * `crypto.timingSafeEqual` requires equal-length buffers, so both operands are first
 * reduced to fixed-length SHA-256 digests (compared in constant time); a final exact
 * byte-length check rules out the astronomically unlikely digest collision. The work
 * performed does not vary with where the first differing byte is.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  const ha = crypto.createHash("sha256").update(ba).digest();
  const hb = crypto.createHash("sha256").update(bb).digest();
  return crypto.timingSafeEqual(ha, hb) && ba.length === bb.length;
}

/** The token presented on the dedicated header, or null when missing/empty. */
function presentedInternalServiceToken(req: Request): string | null {
  const raw = req.headers[INTERNAL_SERVICE_TOKEN_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * True iff the request presents a VALID internal-service token. Returns false — never
 * throws — when the credential is not configured, missing, empty, or incorrect, so a
 * caller can safely fall through to the normal session/capability authorization path.
 * The token is never logged.
 */
export function hasValidInternalServiceToken(req: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = configuredInternalServiceToken(env);
  const presented = presentedInternalServiceToken(req);
  if (configured === null || presented === null) return false;
  return timingSafeEqualStrings(presented, configured);
}
