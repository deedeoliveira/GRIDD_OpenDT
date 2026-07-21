import type { SemanticValidationReport } from "./semanticValidationTypes.ts";

const previewRuns = new Map<string, { report: SemanticValidationReport; dataTurtle: string; expiresAt: number }>();

function prune() {
    const now = Date.now();
    for (const [key, value] of previewRuns) if (value.expiresAt <= now) previewRuns.delete(key);
}

export function storePreviewValidation(report: SemanticValidationReport, dataTurtle: string, ttlMs: number) {
    prune();
    previewRuns.set(report.runUuid, { report, dataTurtle, expiresAt: Date.now() + ttlMs });
}

export function getPreviewValidation(runUuid: string) {
    prune();
    return previewRuns.get(runUuid) ?? null;
}
