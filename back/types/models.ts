export type Model = {
    id: string,
    name: string,
    linkedParentId: string
}

export type LinkedModel = {
    id: string,
    name: string,
    childModels: Model[]
}