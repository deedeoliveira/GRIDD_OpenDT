import { ActorInstitutionalLinkError } from "./actorInstitutionalLinkTypes.ts";

export interface InstitutionalConfig {
    graphEnabled: boolean;
    demoMode: boolean;
    ontologyFamilyKey: string;
    datasetFamilyKey: string;
    bridgeFamilyKey: string;
}

function booleanValue(env: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
    const value = (env[name] ?? String(fallback)).trim().toLowerCase();
    if (!new Set(["true", "false", "1", "0"]).has(value)) {
        throw new ActorInstitutionalLinkError("institutional_feature_disabled", `${name} must be true or false`, 500);
    }
    return value === "true" || value === "1";
}

function familyKey(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
    const value = (env[name] ?? fallback).trim();
    if (!/^[a-z0-9][a-z0-9-]{1,199}$/.test(value)) {
        throw new ActorInstitutionalLinkError("institutional_artifact_not_active", `${name} is invalid`, 500);
    }
    return value;
}

export function loadInstitutionalConfig(env: NodeJS.ProcessEnv = process.env): InstitutionalConfig {
    return {
        graphEnabled: booleanValue(env, "INSTITUTIONAL_GRAPH_ENABLED"),
        demoMode: booleanValue(env, "INSTITUTIONAL_DEMO_MODE"),
        ontologyFamilyKey: familyKey(env, "INSTITUTIONAL_ONTOLOGY_FAMILY_KEY", "uminho-institutional-ontology"),
        datasetFamilyKey: familyKey(env, "INSTITUTIONAL_DATASET_FAMILY_KEY", "uminho-institutional-synthetic-data"),
        bridgeFamilyKey: familyKey(env, "INSTITUTIONAL_BRIDGE_FAMILY_KEY", "project-institutional-bridge"),
    };
}
