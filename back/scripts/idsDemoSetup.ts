import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import MySQLDatabase from "../utils/mysqlDatabase.ts";
import { IdsProfileGovernanceService } from "../requirements/idsProfileGovernanceService.ts";
import { IfcOpenShellIdsValidationProvider } from "../requirements/ifcOpenShellIdsValidationProvider.ts";
import { IDS_DEMO_SCENARIOS, runIdsDemoScenario } from "../requirements/idsDemoService.ts";
import { extractIfcModelFromFile } from "../requirements/ifcFileExtraction.ts";
import { validateDemoProjectRules } from "../requirements/demoProjectRules.ts";
import { loadIdsValidationConfig } from "../requirements/idsValidationConfig.ts";

const execute = process.argv.slice(2).includes("--execute");
if (process.env.NODE_ENV === "production") throw new Error("IDS demo setup refuses production by default.");

const config = loadIdsValidationConfig();
if (!config.enabled || config.mode !== "required" || !config.demoMode) {
    throw new Error("Local demo requires IDS_VALIDATION_ENABLED=true, IDS_VALIDATION_MODE=required, and IDS_DEMO_MODE=true.");
}

const db = new MySQLDatabase();
await db.connect();
const [tables]: any = await db.connection.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name IN ('semantic_artifacts','model_requirement_validation_runs','model_requirement_validation_results')
`);
const found = new Set(tables.map((row: any) => String(row.TABLE_NAME ?? row.table_name)));
for (const required of ["semantic_artifacts", "model_requirement_validation_runs", "model_requirement_validation_results"]) {
    if (!found.has(required)) throw new Error(`Required local migration is absent: table '${required}' was not found.`);
}

const governance = new IdsProfileGovernanceService();
const checked = await governance.validateManifestProfile(config.familyKey);
const provider = new IfcOpenShellIdsValidationProvider();
const expected: Record<string, { ids: boolean; project: boolean }> = {
    "invalid-missing-reference": { ids: false, project: true },
    "valid": { ids: true, project: true },
    "duplicate-reference": { ids: true, project: false },
};
console.log(`Mode: ${execute ? "EXECUTE" : "DRY RUN"}`);
console.log(`IDS executor: ${checked.executor.executorName} ${checked.executor.executorVersion}`);
console.log(`Profile: ${checked.entry.artifactKey} (${checked.entry.storageMode}, no named graph)`);
for (const [scenario, descriptor] of Object.entries(IDS_DEMO_SCENARIOS)) {
    const ifcPath = path.resolve(process.cwd(), "tests", "fixtures", "ids", descriptor.filename);
    const ids = await provider.validate({ ifcPath, profile: checked.profile, correlationId: crypto.randomUUID(), timeoutMs: config.timeoutMs });
    const extracted = await extractIfcModelFromFile(ifcPath, config.timeoutMs);
    const projectPass = !validateDemoProjectRules(extracted).some((item) => item.status === "fail");
    if (ids.conforms !== expected[scenario]!.ids || projectPass !== expected[scenario]!.project) {
        throw new Error(`Synthetic fixture '${scenario}' did not produce its governed expected result.`);
    }
    console.log(`Fixture ${scenario}: IDS=${ids.conforms ? "PASS" : "FAIL"}, project=${projectPass ? "PASS" : "FAIL"}`);
}

if (execute) {
    const activated = await governance.registerAndActivate(config.familyKey);
    console.log(`Active IDS profile: ${activated.artifactUuid} version ${activated.version}`);
    for (const scenario of Object.keys(IDS_DEMO_SCENARIOS) as (keyof typeof IDS_DEMO_SCENARIOS)[]) {
        const result = await runIdsDemoScenario(scenario);
        console.log(`Prepared ${scenario}: overall=${result.report.overallStatus.toUpperCase()}`);
    }
}
console.log("No migration was applied, no graph was written, and no reservation was touched by this command.");
console.log("Open http://localhost:3000/ids-demo");
await db.disconnect();
// Governance/report services own additional short-lived pools. This command is
// an explicit CLI, so terminate only this process after all awaited work; it
// does not stop the backend, frontend, MySQL, Fuseki or Python services.
process.exit(0);
