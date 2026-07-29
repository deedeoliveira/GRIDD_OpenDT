import type { NextFunction, Request, Response } from "express";
import { ApplicationIdentityDatabase } from "./applicationIdentityDatabase.ts";
import type { AccountAuthorization, Capabilities } from "./applicationIdentityTypes.ts";
import { buildErrorResponse } from "../utils/responseHandler.ts";
import { hasValidInternalServiceToken } from "./internalServiceAuth.ts";

// Centralised, capability-based authorization. Route guards must use these
// helpers and never scattered role-string comparisons or the applicationArea
// alias. Capabilities are always resolved server-side from the opaque session.

export async function resolveRequestCapabilities(req: Request): Promise<AccountAuthorization | null> {
  if (!req.applicationIdentity) return null;
  return new ApplicationIdentityDatabase().resolveCapabilities(Number(req.applicationIdentity.accountId));
}

type CapabilityKey = keyof Capabilities;

// Boolean guard for handlers that authorize inline (writes a 401/403/500 body and
// returns false when denied or on failure, true when allowed). It never throws:
// a failed capability lookup (e.g. a database error) is converted into a 500
// response so the caller — inline handler or middleware — cannot produce an
// unhandled promise rejection under any Express version.
export async function ensureCapability(
  req: Request,
  res: Response,
  capability: CapabilityKey,
  code: string,
  message: string,
): Promise<boolean> {
  let authorization;
  try {
    authorization = await resolveRequestCapabilities(req);
  } catch {
    buildErrorResponse(res, 500, "Authorization could not be resolved.", "authorization_unavailable");
    return false;
  }
  if (!authorization) { buildErrorResponse(res, 401, "A local development session is required.", "session_required"); return false; }
  if (!authorization.capabilities[capability]) { buildErrorResponse(res, 403, message, code); return false; }
  return true;
}

// ensureCapability never rejects, so the middleware cannot leave an unhandled
// rejection; next() runs only when the capability is present.
function requireCapability(capability: CapabilityKey, code: string, message: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (await ensureCapability(req, res, capability, code, message)) next();
  };
}

// Every active human account can reserve resources (managers included).
export const requireReserveResources = requireCapability(
  "reserveResources", "reserve_resources_required",
  "The resource-reservation workspace requires an active account.");

export const requireBimManagement = requireCapability(
  "bimManagement", "bim_management_required",
  "This workspace requires the BIM management capability.");

export const requireOperationalManagement = requireCapability(
  "operationalManagement", "operational_management_required",
  "This workspace requires the operational management capability.");

// Boolean variants for handlers that already branch inline.
export const ensureReserveResources = (req: Request, res: Response) =>
  ensureCapability(req, res, "reserveResources", "reserve_resources_required",
    "The resource-reservation workspace requires an active account.");

// Dual authorization for the internal model-version download boundary
// (GET /api/model/versions/:versionId/download). It authorizes EITHER a valid
// internal-service token (the server-to-server Python IFC extractor, which holds no
// browser session) OR an authenticated browser session with reserveResources. The
// internal token is scoped to THIS download decision only: it is checked here and by no
// capability guard, so it can never authorize an unrelated route. When the token is
// absent/invalid we fall through to the normal capability guard, which writes the
// 401/403 body itself. Returns true when authorized; false (with a response already
// written) when denied. This is the exact production decision the route uses.
export async function authorizeModelVersionDownload(req: Request, res: Response): Promise<boolean> {
  if (hasValidInternalServiceToken(req)) return true;
  return ensureReserveResources(req, res);
}
