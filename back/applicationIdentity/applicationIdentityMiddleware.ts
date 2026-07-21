import type { NextFunction, Request, Response } from "express";
import { loadApplicationIdentityConfig } from "./applicationIdentityConfig.ts";
import { ApplicationIdentityDatabase } from "./applicationIdentityDatabase.ts";
import { LocalSyntheticSessionIdentityProvider } from "./localSyntheticSessionIdentityProvider.ts";
import { buildErrorResponse } from "../utils/responseHandler.ts";
declare global { namespace Express { interface Request { applicationIdentity?: any; } } }
const config=loadApplicationIdentityConfig(); const provider=config.mode==='local_session'?new LocalSyntheticSessionIdentityProvider(new ApplicationIdentityDatabase(),config):null;
export async function resolveApplicationIdentity(req:Request,_res:Response,next:NextFunction){ try { req.applicationIdentity=provider?await provider.resolveRequestIdentity(req):null; next(); } catch { buildErrorResponse(_res,401,"Application identity could not be resolved."); } }
export function requireApplicationIdentity(req:Request,res:Response,next:NextFunction){ if(config.mode==='local_session'&&!req.applicationIdentity) return buildErrorResponse(res,401,"A local development session is required."); next(); }
export function applicationIdentityRuntime(){ return {config,provider}; }
