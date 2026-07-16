/**
 * Planeamento (puro, sem I/O) do backfill de versionamento — Prompt 2.
 *
 * Classificações possíveis por versão:
 *   current_file_associated    — ficheiro corrente legado (models/<modelId>.ifc) associado
 *   historical_file_associated — ficheiro de archive associado com confiança (janela temporal única)
 *   missing_file               — nenhum ficheiro identificável (histórico não recuperável)
 *   ambiguous_file             — mais de um candidato; NÃO associar (não inventar histórico)
 *   already_backfilled         — linha já tem os campos preenchidos (2.ª execução é no-op)
 *
 * Ficheiros sem linha correspondente são reportados como órfãos e nunca tocados.
 */

export interface VersionRow {
    id: number;
    model_id: number;
    created_at: Date;
    version_number: number | null;
    status: string | null;
    storage_key: string | null;
}

export interface ModelRow {
    id: number;
    current_version_id: number | null;
}

export interface ArchiveFile {
    /** nome do ficheiro em models/archive, ex.: 1784135203791_3.ifc */
    fileName: string;
    modelId: number;
    /** epoch ms extraído do prefixo do nome (momento em que a versão seguinte foi carregada) */
    archivedAtMs: number;
}

export type FileClassification =
    | "current_file_associated"
    | "historical_file_associated"
    | "missing_file"
    | "ambiguous_file"
    | "already_backfilled";

export interface VersionPlan {
    versionId: number;
    modelId: number;
    versionNumber: number;
    status: "active" | "archived";
    isCurrent: boolean;
    storageKey: string | null;
    classification: FileClassification;
    note?: string | undefined;
}

export function parseArchiveFileName(fileName: string): ArchiveFile | null {
    const match = /^(\d{10,})_(\d+)\.ifc$/i.exec(fileName);
    if (!match) return null;
    return {
        fileName,
        archivedAtMs: Number(match[1]),
        modelId: Number(match[2]),
    };
}

export function planBackfill(
    versions: VersionRow[],
    /** modelIds cujo ficheiro corrente legado models/<id>.ifc existe */
    currentFilesByModel: Set<number>,
    archiveFiles: ArchiveFile[]
): { plans: VersionPlan[]; orphanArchives: ArchiveFile[] } {

    const plans: VersionPlan[] = [];
    const usedArchives = new Set<string>();

    const byModel = new Map<number, VersionRow[]>();
    for (const v of versions) {
        if (!byModel.has(v.model_id)) byModel.set(v.model_id, []);
        byModel.get(v.model_id)!.push(v);
    }

    for (const [modelId, rows] of byModel) {
        rows.sort((a, b) => a.id - b.id);

        /*
         * Associação ordinal por contagem: o fluxo legado arquivava o ficheiro
         * anterior a cada novo upload, portanto os archives de um modelo, por
         * ordem cronológica do prefixo, correspondem 1:1 às versões não-correntes
         * por ordem de criação. A associação só é feita quando as contagens são
         * EXATAMENTE iguais (verificado empiricamente contra o conteúdo dos IFC;
         * a correspondência por janela temporal foi rejeitada por haver desvio
         * entre Date.now() do Node e NOW() do MySQL). Contagens diferentes
         * significam histórico com uploads perdidos → ambiguous_file.
         */
        const modelArchives = archiveFiles
            .filter((a) => a.modelId === modelId)
            .sort((a, b) => a.archivedAtMs - b.archivedAtMs);
        const nonCurrentCount = rows.length - 1;
        const archivesMatchable = modelArchives.length === nonCurrentCount && nonCurrentCount > 0;

        rows.forEach((row, index) => {
            const versionNumber = index + 1;
            const isCurrent = index === rows.length - 1;

            // 2.ª execução: linha já preenchida → não tocar
            if (row.version_number !== null && row.status !== null && row.status !== "processing") {
                plans.push({
                    versionId: row.id, modelId, versionNumber: row.version_number,
                    status: row.status as any, isCurrent,
                    storageKey: row.storage_key,
                    classification: "already_backfilled",
                });
                return;
            }

            let storageKey: string | null = null;
            let classification: FileClassification = "missing_file";
            let note: string | undefined;

            if (isCurrent && currentFilesByModel.has(modelId)) {
                // O ficheiro corrente legado corresponde, por definição do fluxo
                // antigo, à última versão do modelo.
                storageKey = `models/${modelId}.ifc`;
                classification = "current_file_associated";
            } else if (!isCurrent) {
                if (archivesMatchable) {
                    const archive = modelArchives[index]!;
                    usedArchives.add(archive.fileName);
                    storageKey = `models/archive/${archive.fileName}`;
                    classification = "historical_file_associated";
                } else if (modelArchives.length > 0) {
                    classification = "ambiguous_file";
                    note = `${modelArchives.length} archives para ${nonCurrentCount} versões históricas — não associado`;
                } else {
                    classification = "missing_file";
                    note = "histórico não recuperável";
                }
            } else {
                note = "ficheiro corrente legado inexistente";
            }

            plans.push({
                versionId: row.id, modelId, versionNumber,
                status: isCurrent ? "active" : "archived",
                isCurrent, storageKey, classification, note,
            });
        });
    }

    const orphanArchives = archiveFiles.filter((a) => !usedArchives.has(a.fileName));

    return { plans, orphanArchives };
}
