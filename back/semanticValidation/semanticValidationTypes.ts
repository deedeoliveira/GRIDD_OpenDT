export type ShaclValidationMode = "disabled" | "report_only" | "required";
export type ShaclShapesSource = "governed_active_shapes" | "temporary_uploaded_shapes";
export type ShaclInferenceMode = "none" | "rdfs" | "owlrl" | "both";

export interface VisibleShaclConstraint {
    sourceShape: string;
    nodeShape: string;
    targets: Array<{ kind: string; value: string }>;
    path: string | null;
    minCount: number | null;
    maxCount: number | null;
    datatype: string | null;
    class: string | null;
    nodeKind: string | null;
    pattern: string | null;
    severity: string;
    message: string | null;
}

export interface SemanticValidationResultRow {
    focusNode: string | null;
    resultPath: string | null;
    value: string | null;
    sourceShape: string | null;
    sourceConstraintComponent: string | null;
    severity: string | null;
    message: string | null;
}

export interface ShapesSelection {
    source: ShaclShapesSource;
    filename: string;
    familyKey: string | null;
    version: string | null;
    sha256: string;
    artifactId: number | null;
    artifactUuid: string | null;
    namedGraphUri: string | null;
    turtle: string;
    constraints: VisibleShaclConstraint[];
    executorName: string;
    executorVersion: string;
}

export interface SemanticValidationReport {
    runUuid: string;
    correlationId: string;
    validationKind: "model_rdf_structural" | "institutional_structural";
    status: "completed" | "failed";
    conforms: boolean;
    resultCount: number;
    results: SemanticValidationResultRow[];
    constraints: VisibleShaclConstraint[];
    dataGraphSha256: string;
    shapesGraphSha256: string;
    shapesSource: ShaclShapesSource | "governed_institutional_shapes";
    shapesArtifactId: number | null;
    shapesFamilyKey: string | null;
    shapesVersion: string | null;
    shapesFilename: string;
    executorName: string;
    executorVersion: string;
    inferenceMode: ShaclInferenceMode;
    advanced: boolean;
    metaShacl: boolean;
    startedAt: string;
    completedAt: string;
    reportTurtle: string;
    reportSha256: string;
    reportGraphUri: string | null;
    modelVersionId: number | null;
    materialisationId: number | null;
}

export interface SemanticValidationRequest {
    dataTurtle: string;
    shapesTurtle: string;
    ontologyTurtle?: string;
    inference: ShaclInferenceMode;
    advanced: boolean;
    metaShacl: boolean;
    timeoutMs: number;
    correlationId: string;
    signal?: AbortSignal;
}

export interface SemanticValidationProvider {
    readonly providerId: string;
    inspectShapes(request: Omit<SemanticValidationRequest, "dataTurtle">): Promise<{
        constraints: VisibleShaclConstraint[];
        executorName: string;
        executorVersion: string;
    }>;
    validate(request: SemanticValidationRequest): Promise<Omit<SemanticValidationReport,
        "runUuid" | "correlationId" | "validationKind" | "status" | "dataGraphSha256" |
        "shapesGraphSha256" | "shapesSource" | "shapesArtifactId" | "shapesFamilyKey" |
        "shapesVersion" | "shapesFilename" | "inferenceMode" | "advanced" | "metaShacl" |
        "reportGraphUri" | "modelVersionId" | "materialisationId">>;
}

export class SemanticValidationError extends Error {
    constructor(readonly code: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "SemanticValidationError";
    }
}
