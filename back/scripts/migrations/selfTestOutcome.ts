/**
 * Pure outcome classification for the disposable-schema self-test. Separated into
 * its own module so it can be unit-tested without importing (and thereby running)
 * the self-test script. A primary test error OR any cleanup error is a failure;
 * only a completely clean run may continue as success.
 */
export type FailureReason = "none" | "primary" | "cleanup" | "primary+cleanup";

export interface OutcomeInput {
  primaryErrorPresent: boolean;
  cleanupErrorCount: number;
}
export interface Outcome {
  success: boolean;
  failureReason: FailureReason;
}

export function classifyOutcome(input: OutcomeInput): Outcome {
  const primary = input.primaryErrorPresent;
  const cleanup = input.cleanupErrorCount > 0;
  if (!primary && !cleanup) return { success: true, failureReason: "none" };
  if (primary && cleanup) return { success: false, failureReason: "primary+cleanup" };
  if (primary) return { success: false, failureReason: "primary" };
  return { success: false, failureReason: "cleanup" };
}
