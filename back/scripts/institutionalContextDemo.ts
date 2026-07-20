import "dotenv/config";
import { ActorInstitutionalLinkError, sanitizedLinkError } from "../semantic/actorInstitutionalLinkTypes.ts";
import { loadInstitutionalConfig } from "../semantic/institutionalConfig.ts";
import { createInstitutionalRuntime } from "../semantic/institutionalRuntime.ts";
import type { InstitutionalActorContext } from "../semantic/institutionalTypes.ts";

function option(name: string): string | null {
    const index = process.argv.indexOf(`--${name}`);
    const value = index >= 0 ? process.argv[index + 1] : undefined;
    return typeof value === "string" && !value.startsWith("--") ? value : null;
}

export function formatInstitutionalContext(context: InstitutionalActorContext): string {
    const lines = ["Institutional context", "---------------------", `Actor: ${context.actorKey}`, `Link status: ${context.link.status}`];
    if (!context.contextAvailable || !context.person) {
        lines.push(`Context unavailable: ${context.unavailableReason ?? "unknown"}`);
    } else {
        lines.push(`Person: ${context.person.label}`, `Student number: ${context.person.studentNumber ?? "Not asserted"}`, "", "Memberships:");
        for (const membership of context.memberships) {
            lines.push(`- ${membership.organization.label}`, "  Roles:", ...membership.roles.map((role) => `  - ${role.label}`));
        }
        lines.push("", "Supervisors:");
        if (context.supervisors.length === 0) lines.push("- No supervisor assertion is present in the active synthetic graph.");
        else lines.push(...context.supervisors.map((supervisor) => `- ${supervisor.label}`));
        if (context.artifactContext) {
            lines.push("", "Evidence:", `- Institutional dataset version: ${context.artifactContext.datasetVersion}`,
                `- Ontology version: ${context.artifactContext.ontologyVersion}`,
                `- Bridge version: ${context.artifactContext.bridgeVersion}`);
        }
    }
    lines.push("", "Important:", "- Synthetic data", "- Actor is not authenticated",
        "- This is not an eligibility, authorization or reservation decision");
    return lines.join("\n");
}

async function main(): Promise<void> {
    const actor = option("actor");
    if (!actor) throw new ActorInstitutionalLinkError("actor_key_invalid", "--actor is required", 400);
    const config = loadInstitutionalConfig();
    if (!config.graphEnabled || !config.demoMode) {
        throw new ActorInstitutionalLinkError("institutional_feature_disabled", "institutional graph and demo mode must be explicitly enabled", 503);
    }
    console.log(formatInstitutionalContext(await createInstitutionalRuntime(config).context.getActorContext(actor)));
}

if (process.argv[1]?.includes("institutionalContextDemo")) {
    main().catch((error: unknown) => {
        console.error(JSON.stringify({ ok: false, ...sanitizedLinkError(error) }));
        process.exitCode = 1;
    });
}
