import express from "express";
import { loadIdsValidationConfig } from "../requirements/idsValidationConfig.ts";
import { isIdsDemoScenario, runIdsDemoScenario } from "../requirements/idsDemoService.ts";

const router = express.Router();

router.post("/demo/:scenario", async (req, res) => {
    let config;
    try {
        config = loadIdsValidationConfig();
    } catch {
        return res.status(503).json({ ok: false, code: "ids_demo_configuration_error", message: "IDS demonstrator configuration is invalid." });
    }
    if (!config.demoMode) {
        return res.status(404).json({ ok: false, code: "ids_demo_disabled", message: "IDS demonstrator is disabled." });
    }
    if (!isIdsDemoScenario(req.params.scenario)) {
        return res.status(404).json({ ok: false, code: "ids_demo_scenario_not_found", message: "Unknown IDS demonstration scenario." });
    }
    try {
        const result = await runIdsDemoScenario(req.params.scenario);
        return res.json({ ok: true, data: result });
    } catch (error: any) {
        return res.status(503).json({ ok: false, code: "ids_demo_unavailable", message: String(error?.message ?? "IDS demonstration is unavailable.").slice(0, 500) });
    }
});

export default router;
