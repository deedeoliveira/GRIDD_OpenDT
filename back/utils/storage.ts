/**
 * Armazenamento imutável dos ficheiros IFC (Prompt 2).
 *
 * Convenção: models/{modelId}/versions/{versionId}/model.ifc, relativa ao
 * storage root (back/cdn_resources), com separadores POSIX. O caminho real é
 * SEMPRE construído pela aplicação a partir de ids numéricos — o nome original
 * do upload é guardado apenas como metadado (model_versions.original_filename).
 *
 * Ficheiros legados (models/<modelId>.ifc e models/archive/...) continuam a ser
 * lidos através de storage_key resolvido por resolveStorageKey, mas nunca são
 * reescritos: a partir desta etapa cada versão tem o seu próprio ficheiro.
 */
import path from "path";
import fs from "fs";
import crypto from "crypto";

export const STORAGE_ROOT = path.join(import.meta.dirname, "../cdn_resources");

/** Diretório temporário dos uploads (multer) — separado do armazenamento definitivo. */
export const TEMP_DIR = path.join(STORAGE_ROOT, "models/temp");

export function versionStorageKey(modelId: number, versionId: number): string {
    if (!Number.isInteger(modelId) || !Number.isInteger(versionId) || modelId <= 0 || versionId <= 0) {
        throw new Error("Invalid model or version id for storage key");
    }
    return `models/${modelId}/versions/${versionId}/model.ifc`;
}

/**
 * Resolve um storage_key relativo para um caminho absoluto DENTRO do storage
 * root. Rejeita caminhos absolutos e path traversal (../).
 */
export function resolveStorageKey(storageKey: string): string {
    if (!storageKey || path.isAbsolute(storageKey) || /^[a-zA-Z]:/.test(storageKey)) {
        throw new Error("Invalid storage key");
    }

    const root = path.resolve(STORAGE_ROOT);
    const resolved = path.resolve(root, storageKey);

    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error("Invalid storage key (path traversal rejected)");
    }

    return resolved;
}

/** SHA-256 e tamanho de um ficheiro. */
export function hashFile(filePath: string): { fileHash: string; fileSize: number } {
    const data = fs.readFileSync(filePath);
    return {
        fileHash: crypto.createHash("sha256").update(data).digest("hex"),
        fileSize: data.length,
    };
}

/**
 * Promove um ficheiro temporário para o caminho definitivo da versão.
 * Nunca sobrescreve (COPYFILE_EXCL): uma versão nunca substitui outra.
 * Verifica o hash do ficheiro efetivamente armazenado.
 */
export function promoteFile(tempPath: string, storageKey: string, expectedHash: string): string {
    const destination = resolveStorageKey(storageKey);

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(tempPath, destination, fs.constants.COPYFILE_EXCL);

    const { fileHash } = hashFile(destination);
    if (fileHash !== expectedHash) {
        fs.rmSync(destination, { force: true });
        throw new Error("Stored file hash mismatch after promotion");
    }

    return destination;
}

/**
 * Remove o diretório de uma versão (compensação de falha). Caminho construído
 * apenas a partir de ids numéricos — nunca de input externo.
 */
export function removeVersionDir(modelId: number, versionId: number): void {
    const dir = resolveStorageKey(`models/${modelId}/versions/${versionId}`);
    fs.rmSync(dir, { recursive: true, force: true });
}

/** Apaga um ficheiro temporário, se existir (limpeza garantida em finally). */
export function removeTempFile(tempPath: string): void {
    try {
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
        // limpeza best-effort: nunca deve mascarar o erro original
    }
}
