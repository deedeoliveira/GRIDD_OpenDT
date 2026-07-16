/**
 * Testes do armazenamento imutável (Prompt 2) — back/utils/storage.ts.
 * Usam o storage root real (back/cdn_resources) com ids de teste altos
 * (999xxx) e limpeza garantida — o diretório é gitignored.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
    STORAGE_ROOT, versionStorageKey, resolveStorageKey,
    hashFile, promoteFile, removeVersionDir, removeTempFile,
} from "../../utils/storage.ts";

const TEST_MODEL_ID = 999001;

function makeTempFile(content: string): string {
    const p = path.join(os.tmpdir(), `oswadt-test-${Date.now()}-${Math.random().toString(36).slice(2)}.ifc`);
    fs.writeFileSync(p, content);
    return p;
}

after(() => {
    fs.rmSync(path.join(STORAGE_ROOT, `models/${TEST_MODEL_ID}`), { recursive: true, force: true });
});

test("versionStorageKey: caminhos distintos por versão, relativos e POSIX", () => {
    const k1 = versionStorageKey(TEST_MODEL_ID, 1);
    const k2 = versionStorageKey(TEST_MODEL_ID, 2);

    assert.equal(k1, `models/${TEST_MODEL_ID}/versions/1/model.ifc`);
    assert.notEqual(k1, k2);
    assert.ok(!k1.includes("\\"), "sem separadores Windows");
    assert.throws(() => versionStorageKey(0, 1));
    assert.throws(() => versionStorageKey(1.5 as any, 1));
});

test("resolveStorageKey: aceita chaves legadas e novas; rejeita path traversal e caminhos absolutos", () => {
    assert.ok(resolveStorageKey("models/1.ifc").startsWith(path.resolve(STORAGE_ROOT)));
    assert.ok(resolveStorageKey("models/archive/1784135203791_3.ifc").length > 0);

    assert.throws(() => resolveStorageKey("../../../etc/passwd"), /Invalid storage key/);
    assert.throws(() => resolveStorageKey("models/../../secret.txt"), /Invalid storage key/);
    assert.throws(() => resolveStorageKey("/etc/passwd"), /Invalid storage key/);
    assert.throws(() => resolveStorageKey("C:/Windows/system.ini"), /Invalid storage key/);
    assert.throws(() => resolveStorageKey(""), /Invalid storage key/);
});

test("hashFile: SHA-256 e tamanho corretos", () => {
    const temp = makeTempFile("abc");
    try {
        const { fileHash, fileSize } = hashFile(temp);
        assert.equal(fileHash, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert.equal(fileSize, 3);
    } finally {
        removeTempFile(temp);
    }
});

test("promoteFile: promove com verificação de hash e NUNCA sobrescreve uma versão existente", () => {
    const content = "ISO-10303-21; teste";
    const temp1 = makeTempFile(content);
    const temp2 = makeTempFile(content);
    const key = versionStorageKey(TEST_MODEL_ID, 1);
    const { fileHash } = hashFile(temp1);

    try {
        const stored = promoteFile(temp1, key, fileHash);
        assert.ok(fs.existsSync(stored), "ficheiro promovido existe");
        assert.equal(fs.readFileSync(stored, "utf-8"), content);

        // imutabilidade: promover de novo para a MESMA versão falha
        assert.throws(() => promoteFile(temp2, key, fileHash), /EEXIST/);

        // versão seguinte tem caminho próprio e não toca na anterior
        const key2 = versionStorageKey(TEST_MODEL_ID, 2);
        promoteFile(temp2, key2, fileHash);
        assert.ok(fs.existsSync(stored), "ficheiro da v1 permanece intacto");
        assert.ok(fs.existsSync(resolveStorageKey(key2)));
    } finally {
        removeTempFile(temp1);
        removeTempFile(temp2);
        removeVersionDir(TEST_MODEL_ID, 1);
        removeVersionDir(TEST_MODEL_ID, 2);
    }
});

test("promoteFile: hash divergente após escrita → erro e ficheiro removido", () => {
    const temp = makeTempFile("conteudo");
    const key = versionStorageKey(TEST_MODEL_ID, 3);

    try {
        assert.throws(() => promoteFile(temp, key, "0".repeat(64)), /hash mismatch/);
        assert.ok(!fs.existsSync(resolveStorageKey(key)), "ficheiro com hash errado não fica no storage");
    } finally {
        removeTempFile(temp);
        removeVersionDir(TEST_MODEL_ID, 3);
    }
});

test("removeTempFile: limpa temporários e é inofensivo quando o ficheiro já não existe", () => {
    const temp = makeTempFile("x");
    removeTempFile(temp);
    assert.ok(!fs.existsSync(temp));
    removeTempFile(temp); // segunda chamada não lança
});
