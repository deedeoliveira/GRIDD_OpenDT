/** Prompt 7B2 read-only institutional context API. No mutation routes exist. */
import express, { type Request, type Response } from "express";
import crypto from "node:crypto";
import { ActorInstitutionalLinkError, sanitizedLinkError } from "../semantic/actorInstitutionalLinkTypes.ts";
import { loadInstitutionalConfig, type InstitutionalConfig } from "../semantic/institutionalConfig.ts";
import type { InstitutionalContextService } from "../semantic/institutionalContextService.ts";
import { createInstitutionalRuntime } from "../semantic/institutionalRuntime.ts";
import { SYNTHETIC_ACTOR_LINKS } from "../semantic/syntheticActorLinkSeed.ts";

export interface InstitutionalRouteDependencies {
    config: InstitutionalConfig;
    getContextService(): InstitutionalContextService;
}

export async function handleActorContext(req: Request, res: Response, dependencies: InstitutionalRouteDependencies): Promise<void> {
    if (!dependencies.config.graphEnabled) {
        res.status(503).json({ ok: false, code: "institutional_feature_disabled", message: "Institutional context is unavailable" });
        return;
    }
    try {
        const context = await dependencies.getContextService().getActorContext(String(req.params.actorKey ?? ""), crypto.randomUUID());
        res.status(200).json({ ok: true, status: 200, data: context });
    } catch (error) {
        const sanitized = sanitizedLinkError(error);
        const status = error instanceof ActorInstitutionalLinkError ? error.httpStatus : 500;
        res.status(status).json({ ok: false, status, ...sanitized });
    }
}

export function handleDemoActors(_req: Request, res: Response, dependencies: InstitutionalRouteDependencies): void {
    if (!dependencies.config.demoMode) {
        res.status(404).json({ ok: false, status: 404, code: "not_found", message: "Not found" });
        return;
    }
    res.status(200).json({
        ok: true,
        status: 200,
        data: SYNTHETIC_ACTOR_LINKS.filter((item) => item.actorKey !== "TEST-ACTOR-PROFESSOR-001").map((item) => ({
            actorKey: item.actorKey,
            scenario: item.actorKey === "TEST-ACTOR-STUDENT-001"
                ? "complete_context"
                : item.actorKey === "TEST-ACTOR-STUDENT-002" ? "no_supervisor_assertion" : "revoked_link",
        })),
    });
}

export function createInstitutionalRouter(dependencies?: InstitutionalRouteDependencies): express.Router {
    const router = express.Router();
    let cached: InstitutionalContextService | null = null;
    const resolved = dependencies ?? {
        config: loadInstitutionalConfig(),
        getContextService: () => {
            cached ??= createInstitutionalRuntime().context;
            return cached;
        },
    };
    router.get("/actors/:actorKey/context", (req, res) => { void handleActorContext(req, res, resolved); });
    router.get("/demo/actors", (req, res) => { handleDemoActors(req, res, resolved); });
    return router;
}

export default createInstitutionalRouter();
