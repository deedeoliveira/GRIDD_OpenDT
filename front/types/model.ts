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