import "dotenv/config";
import { IDS_DEMO_SCENARIOS, isIdsDemoScenario, runIdsDemoScenario } from "../requirements/idsDemoService.ts";

const args = process.argv.slice(2);
const index = args.indexOf("--scenario");
const scenario = index >= 0 ? args[index + 1] : undefined;
if (!scenario || !isIdsDemoScenario(scenario)) {
    console.error(`Use --scenario with one of: ${Object.keys(IDS_DEMO_SCENARIOS).join(", ")}`);
    process.exitCode = 1;
} else {
    try {
        const result = await runIdsDemoScenario(scenario);
        const report = result.report;
        console.log("IFC information-requirement validation");
        console.log("--------------------------------------");
        console.log(`Scenario: ${result.title}`);
        console.log(`Overall result: ${report.overallStatus.toUpperCase()}`);
        console.log(`IDS profile: ${report.idsStatus.toUpperCase()} (${report.profile?.version ?? "not evaluated"})`);
        console.log(`Project rules: ${report.projectRulesStatus.toUpperCase()}`);
        for (const finding of report.findings.filter((item) => item.status === "fail")) {
            console.log(`- [${finding.source}] ${finding.message}`);
        }
        console.log(`Meaning: ${result.explanation}`);
    } catch (error: any) {
        console.error(String(error?.message ?? "IDS demonstration is unavailable.").slice(0, 500));
        process.exitCode = 1;
    }
}
