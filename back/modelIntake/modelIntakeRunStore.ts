import type { PreflightRun } from "./modelIntakeTypes.ts";

const runs = new Map<string, PreflightRun>();

export function storePreflightRun(run: PreflightRun): void {
    prunePreflightRuns();
    runs.set(run.runUuid, run);
}

export function getPreflightRun(runUuid: string): PreflightRun | null {
    prunePreflightRuns();
    return runs.get(runUuid) ?? null;
}

export function prunePreflightRuns(now = Date.now()): void {
    for (const [key, run] of runs) {
        if (Date.parse(run.expiresAt) <= now) runs.delete(key);
    }
}
