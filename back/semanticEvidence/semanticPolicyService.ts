import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadGraphConfig } from "../graph/graphConfig.ts";
import { semanticPolicyGraphUri } from "../graph/namedGraphs.ts";
import { SemanticArtifactDatabase, type SemanticArtifactDatabasePort } from "../utils/semanticArtifactDatabase.ts";
import { PyShaclValidationProvider } from "../semanticValidation/pyShaclValidationProvider.ts";
import type { SemanticValidationProvider } from "../semanticValidation/semanticValidationTypes.ts";
import { validateShapesTurtleSecurity } from "../semanticValidation/shapeSetService.ts";
import { loadSemanticValidationConfig } from "../semanticValidation/semanticValidationConfig.ts";
import { loadSemanticEvidenceConfig } from "./semanticEvidenceConfig.ts";
import { SemanticEvidenceError, type PolicySelection } from "./semanticEvidenceTypes.ts";

function sha256(bytes: Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }

export class SemanticPolicyService {
    constructor(
        private readonly db: SemanticArtifactDatabasePort = new SemanticArtifactDatabase(),
        private readonly provider: SemanticValidationProvider = new PyShaclValidationProvider(),
    ) {}

    async resolveActive(familyKey = loadSemanticEvidenceConfig().policyFamilyKey): Promise<PolicySelection> {
        const family = await this.db.findFamilyByKey(familyKey);
        if (!family || family.artifact_type !== "semantic_policy" || family.current_artifact_id === null) {
            throw new SemanticEvidenceError("semantic_policy_unavailable", `No active governed semantic policy exists for '${familyKey}'.`, 503);
        }
        const artifact = await this.db.findArtifactById(Number(family.current_artifact_id));
        if (!artifact || artifact.lifecycle_status !== "active" || artifact.validation_status !== "graph_verified"
            || artifact.storage_mode !== "graph_backed" || artifact.privacy_classification !== "public_research_artifact") {
            throw new SemanticEvidenceError("semantic_policy_invalid", "The active semantic policy is not public, graph-verified and graph-backed.", 503);
        }
        const graph = loadGraphConfig();
        if (!graph.configured) throw new SemanticEvidenceError("graph_not_configured", graph.reason, 503);
        const expected = semanticPolicyGraphUri(graph.config.baseUri, artifact.artifact_uuid);
        if (artifact.named_graph_uri !== expected) throw new SemanticEvidenceError("semantic_policy_graph_mismatch", "The active policy graph URI is not governed.", 503);
        const root = loadSemanticEvidenceConfig().artifactRoot;
        const absolutePath = path.resolve(root, artifact.repository_relative_path);
        if (!absolutePath.startsWith(root + path.sep)) throw new SemanticEvidenceError("semantic_policy_path_invalid", "The governed policy path escapes the artifact root.", 503);
        const bytes = fs.readFileSync(absolutePath);
        if (bytes.length !== Number(artifact.byte_size) || sha256(bytes) !== artifact.sha256) {
            throw new SemanticEvidenceError("semantic_policy_integrity_failed", "The governed policy failed hash or size verification.", 503);
        }
        const turtle = bytes.toString("utf8");
        validateShapesTurtleSecurity(turtle, false);
        const shacl = loadSemanticValidationConfig();
        const inspected = await this.provider.inspectShapes({ shapesTurtle: turtle, inference: "none", advanced: true,
            metaShacl: true, timeoutMs: shacl.timeoutMs, correlationId: crypto.randomUUID() });
        console.log(JSON.stringify({ type: "semantic_policy_resolved", artifactUuid: artifact.artifact_uuid,
            familyKey, policyHash: artifact.sha256, constraintCount: inspected.constraints.length, at: new Date().toISOString() }));
        return { artifactId: Number(artifact.id), artifactUuid: artifact.artifact_uuid, familyKey,
            filename: path.basename(absolutePath), version: artifact.semantic_version, sha256: artifact.sha256,
            namedGraphUri: expected, turtle, constraints: inspected.constraints,
            executorName: inspected.executorName, executorVersion: inspected.executorVersion };
    }
}
