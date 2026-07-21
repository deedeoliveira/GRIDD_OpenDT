import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { getGraphClient } from "../graph/graphClientProvider.ts";
import { IdsProfileGovernanceService } from "../requirements/idsProfileGovernanceService.ts";
import { loadModelIntakeConfig } from "../modelIntake/modelIntakeConfig.ts";
import { MappingProfileService } from "../modelIntake/mappingProfileService.ts";
import MySQLDatabase from "../utils/mysqlDatabase.ts";

async function migrationState() {
    const db = new MySQLDatabase();
    await db.checkConnection();
    const [tables]: any = await db.connection.execute(`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = 'model_version_semantic_materialisations'`, { schema: process.env.DB_NAME });
    const [columns]: any = await db.connection.execute(`SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = :schema AND ((TABLE_NAME='models' AND COLUMN_NAME='model_uuid')
          OR (TABLE_NAME='model_versions' AND COLUMN_NAME='version_uuid'))`, { schema: process.env.DB_NAME });
    return { ready: tables.length === 1 && columns.length === 2, table: tables.length === 1, stableUuidColumns: columns.length === 2 };
}

async function main() {
    const execute = process.argv.includes("--execute");
    const config = loadModelIntakeConfig();
    const migrations = await migrationState();
    if (!migrations.ready) throw new Error("Prompt 7D migration is not applied. Apply it manually before setup.");
    const mappingService = new MappingProfileService();
    const mappingChecked = await mappingService.validateManifestProfile(config.mappingFamilyKey);
    const idsChecked = await new IdsProfileGovernanceService().validateManifestProfile(process.env.IDS_PROFILE_FAMILY_KEY ?? "oswadt-ifc4-model-requirements");
    const graph = await getGraphClient().healthCheck();
    if (!graph.ok) throw new Error(`Graph service is unavailable (${graph.errorCode}).`);
    const demoDir = path.resolve(process.cwd(), "../documentation/demo-inputs/model-intake");
    const examples = ["model-v1.ifc", "model-v2-same-identities.ifc", "ids-reference-required.ids", "ids-reference-and-extra-property.ids"];
    const missing = examples.filter((name) => !fs.existsSync(path.join(demoDir, name)));
    if (missing.length) throw new Error(`Controlled example inputs are missing: ${missing.join(", ")}`);
    if (!config.workspaceEnabled || !config.temporaryIdsUploadEnabled || !config.materialisationEnabled || config.mode !== "required") {
        throw new Error("Local demo requires MODEL_INTAKE_WORKSPACE_ENABLED=true, TEMPORARY_IDS_UPLOAD_ENABLED=true, IFC_RDF_MATERIALISATION_ENABLED=true and IFC_RDF_MATERIALISATION_MODE=required.");
    }
    let mappingActivation: any = { planned: true };
    if (execute) mappingActivation = await mappingService.registerAndActivate(config.mappingFamilyKey);
    console.log(JSON.stringify({ ok: true, dryRun: !execute, migrations, mysql: "available", graph: "available",
        pythonExecutor: `${idsChecked.executor.executorName} ${idsChecked.executor.executorVersion}`,
        activeIdsExpected: { familyKey: idsChecked.profile.familyKey, version: idsChecked.entry.semanticVersion, sha256: idsChecked.entry.sha256 },
        mapping: { familyKey: config.mappingFamilyKey, version: mappingChecked.entry.semanticVersion,
            sha256: mappingChecked.entry.sha256, activation: execute ? "active" : "planned" },
        examples, automaticModelVersionsCreated: 0, migrationsAppliedBySetup: 0, graphResets: 0,
        url: "http://localhost:3000/dashboard", ...(execute ? { mappingArtifactId: mappingActivation.artifactId } : {}) }, null, 2));
}

main()
    .then(() => process.exit(0))
    .catch((error) => { console.error(JSON.stringify({ ok: false, message: String(error?.message ?? error).slice(0, 1000) })); process.exit(1); });
