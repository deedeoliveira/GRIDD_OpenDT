/**
 * Replay auditável de registos não modelados concluídos cujo recurso deixou
 * de existir no grafo operacional. Não é endpoint público e não lê a tabela
 * `assets` para reconstruir RDF: usa apenas os registos append-only de
 * `semantic_sync_operations` e o serviço real de registo.
 *
 * Uso:
 *   npx tsx scripts/recoverNonModelledRegistrations.ts <operation-uuid> [...]
 */
import "dotenv/config";
import nonModelledDb from "../utils/nonModelledAssetDatabase.ts";
import registrationService from "../services/nonModelledAssetRegistrationService.ts";
import reconciliationService from "../services/graphSqlReconciliationService.ts";

async function main(): Promise<void> {
    const operationUuids = process.argv.slice(2);
    if (operationUuids.length === 0) {
        throw new Error("provide one or more original completed register_asset operation UUIDs");
    }

    const results = [];
    for (const operationUuid of operationUuids) {
        const original = await nonModelledDb.findOperationByUuid(operationUuid);
        if (!original) throw new Error(`sync operation ${operationUuid} was not found`);
        const recovery = await registrationService.recoverCompletedRegistration(original);
        const projection = await nonModelledDb.findAssetByUuid(recovery.assetUuid);
        if (!projection) throw new Error(`SQL projection for recovered asset ${recovery.assetUuid} is absent; stop for reconciliation diagnosis`);
        results.push({
            recovery,
            reservabilityReassessment: await reconciliationService.reassessReservability(projection.id),
        });
    }
    console.log(JSON.stringify({ results }, null, 2));
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("recoverNonModelledRegistrations.ts")) {
    main()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error(error instanceof Error ? error.message : error);
            process.exit(1);
        });
}
