import { normalizeActorKey } from "../semantic/actorInstitutionalLinkTypes.ts";

/**
 * Development-only stand-in for the authenticated principal.  This is the
 * sole actor source for the current student application; it is not an
 * authentication mechanism.
 */
export function resolveCurrentApplicationActor(env: NodeJS.ProcessEnv = process.env) {
    const raw = env.CURRENT_APPLICATION_ACTOR_KEY ?? "pg202404";
    return normalizeActorKey(raw).original;
}

export function assertCurrentApplicationActor(clientActor: unknown, env: NodeJS.ProcessEnv = process.env) {
    const current = resolveCurrentApplicationActor(env);
    if (clientActor === undefined || clientActor === null || clientActor === "") return current;
    const supplied = normalizeActorKey(String(clientActor)).original;
    if (supplied.toLocaleLowerCase("en-US") !== current.toLocaleLowerCase("en-US")) {
        const error = new Error("The supplied actor does not match the current application actor.");
        (error as Error & { httpStatus: number; code: string }).httpStatus = 403;
        (error as Error & { httpStatus: number; code: string }).code = "current_actor_mismatch";
        throw error;
    }
    return current;
}
