import crypto from "node:crypto";
import { SemanticArtifactError } from "./artifactTypes.ts";
import type { ArtifactSetActivationResult, SemanticArtifactDatabasePort } from "../utils/semanticArtifactDatabase.ts";

// Rollout-scoped IFC4x3 compatibility set (ADR-0052 §G). This is NOT a
// general "all families must share a semver" rule — it is the explicit,
// named triplet that must move together for the OSWADT IFC4x3 rollout.
const IFC4X3_SOURCE_VERSION = "1.0.0";
const IFC4X3_TARGET_VERSION = "1.1.0";
const IFC4X3_COMPATIBILITY_FAMILY_KEYS: readonly string[] = [
    "oswadt-ifc4-model-requirements",
    "oswadt-ifc4-minimal-rdf-mapping",
    "oswadt-model-rdf-structural-shapes",
];

export interface Ifc4x3TripletActivationRuntime {
    newUuid(): string;
}

export class Ifc4x3TripletActivationService {
    constructor(
        private readonly db: SemanticArtifactDatabasePort,
        private readonly runtime: Ifc4x3TripletActivationRuntime = { newUuid: () => crypto.randomUUID() }
    ) {}

    /**
     * Atomically switches the governed IFC4x3 compatibility triplet from the
     * 1.0.0 source set to the 1.1.0 target set, or fails closed. See
     * SemanticArtifactDatabase.activateArtifactSet for the transactional
     * source/target classification and all-or-nothing write guarantee.
     */
    async activateGovernedTargetSet(): Promise<ArtifactSetActivationResult> {
        const items = [];
        for (const familyKey of IFC4X3_COMPATIBILITY_FAMILY_KEYS) {
            const family = await this.db.findFamilyByKey(familyKey);
            if (!family) throw new SemanticArtifactError("artifact_not_found", `governed IFC4x3 family '${familyKey}' was not found`);
            const target = await this.db.findArtifactByFamilyVersion(Number(family.id), IFC4X3_TARGET_VERSION);
            if (!target) throw new SemanticArtifactError("artifact_not_found", `family '${familyKey}' has no registered ${IFC4X3_TARGET_VERSION} revision`);

            const idempotencyKey = `ifc4x3-triplet-activation:${IFC4X3_TARGET_VERSION}:${familyKey}`;
            const operation = await this.db.ensureOperation({
                operationUuid: this.runtime.newUuid(),
                idempotencyKey,
                artifactId: Number(target.id),
                operationType: "activate_existing",
                payloadHash: crypto.createHash("sha256").update(JSON.stringify({
                    familyKey,
                    operationType: "activate_existing",
                    targetArtifactId: Number(target.id),
                })).digest("hex"),
                previousArtifactId: family.current_artifact_id === null ? null : Number(family.current_artifact_id),
            });

            items.push({
                familyKey,
                targetArtifactId: Number(target.id),
                expectedSourceVersion: IFC4X3_SOURCE_VERSION,
                targetVersion: IFC4X3_TARGET_VERSION,
                operationUuid: operation.operation_uuid,
            });
        }
        return this.db.activateArtifactSet({ items });
    }
}
