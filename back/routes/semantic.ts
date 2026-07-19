/**
 * Rotas administrativas da sincronização semântica (Prompt 5B):
 * retry de operações e reconciliação grafo–SQL.
 *
 * LIMITAÇÃO DOCUMENTADA: a aplicação não tem autenticação — estes endpoints
 * são administrativos (uso via Bruno/curl) e NÃO devem ser expostos
 * publicamente; nenhum sistema novo de autenticação foi introduzido nesta
 * etapa (risco registado em PROMPT5B_NON_MODELLED.md).
 */
import express from "express";
import nonModelledDb from "../utils/nonModelledAssetDatabase.ts";
import registrationService from "../services/nonModelledAssetRegistrationService.ts";
import locationService from "../services/nonModelledAssetLocationService.ts";
import reconciliationService from "../services/graphSqlReconciliationService.ts";
import { NonModelledAssetError } from "../services/nonModelledAssetTypes.ts";
import { buildSuccessResponse, buildErrorResponse } from "../utils/responseHandler.ts";

const app = express();
app.use(express.json());

function errorResponse(res: any, error: any) {
    if (error instanceof NonModelledAssetError) {
        return buildErrorResponse(res, error.statusCode, error.message);
    }
    return buildErrorResponse(res, 500, error?.message ?? "Unexpected error");
}

/* Retry MANUAL de uma operação de sincronização (reutiliza UUIDs/URIs) */
app.post("/sync/:operationId/retry", async (req, res) => {
    const operationId = Number(req.params.operationId);
    if (!Number.isInteger(operationId) || operationId <= 0) {
        return buildErrorResponse(res, 400, "Valid operation ID is required");
    }

    try {
        const operation = await nonModelledDb.findOperationById(operationId);
        if (!operation) {
            return buildErrorResponse(res, 404, `Sync operation ${operationId} not found`);
        }
        if (operation.status === "failed_terminal") {
            return buildErrorResponse(res, 409, `Operation ${operation.operation_uuid} is failed_terminal — diagnose and register a new command`);
        }
        // o incremento de attempt_count acontece DENTRO de resumeOperation
        // (apenas quando há reexecução real; completed devolve o existente)
        const result = operation.operation_type === "register_asset"
            ? await registrationService.resumeOperation(operation)
            : await locationService.resumeOperation(operation);

        return buildSuccessResponse(res, 200, result);
    } catch (error: any) {
        return errorResponse(res, error);
    }
});

/* Reconciliação grafo–SQL — modo relatório (só leitura) */
app.get("/reconciliation/report", async (_req, res) => {
    try {
        const report = await reconciliationService.report();
        return buildSuccessResponse(res, 200, report);
    } catch (error: any) {
        return errorResponse(res, error);
    }
});

/* Reconciliação grafo–SQL — aplica APENAS correções seguras (idempotente) */
app.post("/reconciliation/apply-safe", async (_req, res) => {
    try {
        const result = await reconciliationService.applySafe();
        return buildSuccessResponse(res, 200, result);
    } catch (error: any) {
        return errorResponse(res, error);
    }
});

export default app;
