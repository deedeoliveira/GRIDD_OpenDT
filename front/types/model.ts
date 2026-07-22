export type Model = {
    id: string,
    name: string,
    federatedParentId: string
}

export type LinkedModel = {
    id: string,
    name: string,
    childModels: Model[]
}

export type StudentModelContext = {
    modelLineId: number;
    modelLineUuid: string;
    modelLineName: string;
    linkedModelId: number;
    linkedModelName: string;
    currentVersionId: number | null;
    currentVersionNumber: number | null;
    currentVersionStatus: string | null;
    versionCount: number;
    latestVersion: {
        id: number;
        status: string;
        createdAt: string | null;
        failureStage: string | null;
        message: string | null;
    } | null;
};
