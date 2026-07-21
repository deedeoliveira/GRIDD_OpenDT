import express from "express";
import { getReservationSemanticEvidenceService } from "../semanticEvidence/semanticEvidenceRuntime.ts";
import { SemanticEvidenceError, sanitizedSemanticEvidenceError } from "../semanticEvidence/semanticEvidenceTypes.ts";

export function createSemanticEvidenceRouter(): express.Router {
    const router = express.Router();
    router.get("/runs/:runUuid", async (req, res) => {
        try {
            const run = await getReservationSemanticEvidenceService().getRun(String(req.params.runUuid));
            res.status(200).json({ ok: true, status: 200, data: run.response });
        } catch (error) {
            const safe = sanitizedSemanticEvidenceError(error);
            res.status(error instanceof SemanticEvidenceError ? error.httpStatus : 500).json({ ok: false, ...safe });
        }
    });
    router.get("/runs/:runUuid/evidence.ttl", async (req, res) => {
        try {
            const turtle = await getReservationSemanticEvidenceService().graphTurtle(String(req.params.runUuid), "evidence");
            res.status(200).type("text/turtle").send(turtle);
        } catch (error) {
            const safe = sanitizedSemanticEvidenceError(error);
            res.status(error instanceof SemanticEvidenceError ? error.httpStatus : 500).json({ ok: false, ...safe });
        }
    });
    router.get("/runs/:runUuid/report.ttl", async (req, res) => {
        try {
            const turtle = await getReservationSemanticEvidenceService().graphTurtle(String(req.params.runUuid), "report");
            res.status(200).type("text/turtle").send(turtle);
        } catch (error) {
            const safe = sanitizedSemanticEvidenceError(error);
            res.status(error instanceof SemanticEvidenceError ? error.httpStatus : 500).json({ ok: false, ...safe });
        }
    });
    return router;
}

export default createSemanticEvidenceRouter();
