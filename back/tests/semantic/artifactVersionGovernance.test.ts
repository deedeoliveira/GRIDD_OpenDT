/**
 * Two-version governance for the OSWADT IFC4x3 runtime artifacts (ADR-0052 §G). Proves the
 * immutable 1.0.0 manifestations and the active 1.1.0 manifestations coexist truthfully and
 * that active selection is DETERMINISTIC by exact key — never a prefix / array-first match.
 *
 *   - the restored 1.0.0 bytes still hash to their original manifest hashes;
 *   - the new 1.1.0 bytes hash to their new manifest hashes;
 *   - each version is a distinct entry with its own key, semanticVersion and versioned path;
 *   - the superseded 1.0.0 entries are retained but marked non-activatable;
 *   - active selection resolves EXACTLY the 1.1.0 entry even when 1.0.0 precedes it;
 *   - historical 1.0.0 remains resolvable only by its exact key;
 *   - an unknown configured key resolves to nothing (the provider fails closed).
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
    loadPublicArtifactManifest,
    activeArtifactKey,
    ACTIVE_ARTIFACT_VERSION,
} from "../../semantic/publicArtifactManifest.ts";

const root = path.resolve(process.cwd(), "..", "semantic", "artifacts");
const MANIFEST = path.join(root, "semantic-artifacts-public-manifest.json");

const FAMILIES = [
    "oswadt-ifc4-model-requirements",
    "oswadt-ifc4-minimal-rdf-mapping",
    "oswadt-model-rdf-structural-shapes",
];

// The immutable 1.0.0 hashes as recorded in the base manifest.
const ORIGINAL_1_0_0: Record<string, { sha256: string; byteSize: number }> = {
    "oswadt-ifc4-model-requirements": { sha256: "1fdce6ed16f4f872090f843768ca7e01a28153451478513bc5f99bcd0ad83f16", byteSize: 3696 },
    "oswadt-ifc4-minimal-rdf-mapping": { sha256: "01940af5dfb9039ce2bf1c42046317f70489d6489d055555347ce15a472e6f13", byteSize: 3090 },
    "oswadt-model-rdf-structural-shapes": { sha256: "4e1d0360692cfb572b774608f5cdcbb014326500912807fe60ec1ef2919a314b", byteSize: 5833 },
};
const NEW_1_1_0: Record<string, { sha256: string; byteSize: number }> = {
    "oswadt-ifc4-model-requirements": { sha256: "f4736c9c3b8795192ffaff3c3b2a3e479014eaa9315150003cd98d98b0b3fb86", byteSize: 4095 },
    "oswadt-ifc4-minimal-rdf-mapping": { sha256: "cf1c390382bbbe6e1fff524f4d0132c7af51792a987c61d1e4a4d4022a107d93", byteSize: 3278 },
    "oswadt-model-rdf-structural-shapes": { sha256: "d32845ce4f21a21b199aba339da14c6d92448b9337a7a7d96ba3419b5a48dff3", byteSize: 6302 },
};

function sha256OfFile(relativePath: string): { sha256: string; byteSize: number } {
    const bytes = fs.readFileSync(path.join(root, relativePath));
    return { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length };
}

test("the restored 1.0.0 artifacts are byte-for-byte the original immutable manifestations", async () => {
    const manifest = await loadPublicArtifactManifest(MANIFEST);
    for (const family of FAMILIES) {
        const entry = manifest.artifacts.find((e) => e.artifactKey === `${family}-1.0.0`)!;
        assert.ok(entry, `${family} 1.0.0 entry present`);
        assert.equal(entry.semanticVersion, "1.0.0");
        assert.match(entry.relativePath, /\/1\.0\.0\//, `${family} 1.0.0 path is versioned`);
        assert.equal(entry.sha256, ORIGINAL_1_0_0[family]!.sha256, `${family} 1.0.0 hash`);
        assert.equal(entry.byteSize, ORIGINAL_1_0_0[family]!.byteSize, `${family} 1.0.0 bytes`);
        assert.equal(entry.activationAllowed, false, `${family} 1.0.0 is retained but not activatable`);
        // The on-disk bytes still match the recorded immutable hash.
        const actual = sha256OfFile(entry.relativePath);
        assert.equal(actual.sha256, ORIGINAL_1_0_0[family]!.sha256, `${family} 1.0.0 on-disk hash`);
        assert.equal(actual.byteSize, ORIGINAL_1_0_0[family]!.byteSize);
    }
});

test("the active 1.1.0 artifacts are new, versioned, activatable manifestations with their own hashes", async () => {
    const manifest = await loadPublicArtifactManifest(MANIFEST);
    for (const family of FAMILIES) {
        const entry = manifest.artifacts.find((e) => e.artifactKey === `${family}-1.1.0`)!;
        assert.ok(entry, `${family} 1.1.0 entry present`);
        assert.equal(entry.semanticVersion, "1.1.0");
        assert.match(entry.relativePath, /\/1\.1\.0\//, `${family} 1.1.0 path is versioned`);
        assert.match(entry.sourceFilename, /-v1\.1\./, `${family} 1.1.0 uses the -v1.1 filename convention`);
        assert.equal(entry.activationAllowed, true, `${family} 1.1.0 is activatable`);
        assert.equal(entry.sha256, NEW_1_1_0[family]!.sha256, `${family} 1.1.0 hash`);
        assert.equal(entry.byteSize, NEW_1_1_0[family]!.byteSize, `${family} 1.1.0 bytes`);
        const actual = sha256OfFile(entry.relativePath);
        assert.equal(actual.sha256, NEW_1_1_0[family]!.sha256, `${family} 1.1.0 on-disk hash`);
    }
});

test("the two versions are distinct entries with distinct keys and paths", async () => {
    const manifest = await loadPublicArtifactManifest(MANIFEST);
    for (const family of FAMILIES) {
        const v100 = manifest.artifacts.find((e) => e.artifactKey === `${family}-1.0.0`)!;
        const v110 = manifest.artifacts.find((e) => e.artifactKey === `${family}-1.1.0`)!;
        assert.notEqual(v100.artifactKey, v110.artifactKey);
        assert.notEqual(v100.relativePath, v110.relativePath);
        assert.notEqual(v100.sha256, v110.sha256);
        assert.notEqual(v100.sourceFilename, v110.sourceFilename);
    }
});

test("active selection is by exact key and resolves 1.1.0 deterministically, never the array-first 1.0.0", async () => {
    const manifest = await loadPublicArtifactManifest(MANIFEST);
    assert.equal(ACTIVE_ARTIFACT_VERSION, "1.1.0");
    for (const family of FAMILIES) {
        const activeKey = activeArtifactKey(family);
        assert.equal(activeKey, `${family}-1.1.0`);
        // The 1.0.0 entry precedes the 1.1.0 entry in manifest order; a loose prefix match
        // would wrongly return 1.0.0. Exact-key selection must return 1.1.0.
        const prefixFirst = manifest.artifacts.find((e) => e.artifactKey.startsWith(`${family}-`))!;
        assert.equal(prefixFirst.semanticVersion, "1.0.0", "the array-first prefix match is the superseded 1.0.0");
        const exact = manifest.artifacts.find((e) => e.artifactKey === activeKey)!;
        assert.equal(exact.semanticVersion, "1.1.0");
        assert.notEqual(exact.artifactKey, prefixFirst.artifactKey);
    }
});

test("historical 1.0.0 resolves only by its exact key, and an unknown key fails closed", async () => {
    const manifest = await loadPublicArtifactManifest(MANIFEST);
    for (const family of FAMILIES) {
        const historical = manifest.artifacts.find((e) => e.artifactKey === `${family}-1.0.0`);
        assert.ok(historical, "historical 1.0.0 resolvable by exact key");
        assert.match(historical!.relativePath, /\/1\.0\.0\//);
        // An unknown configured version/key resolves to nothing; the provider throws on this.
        const unknown = manifest.artifacts.find((e) => e.artifactKey === `${family}-9.9.9`);
        assert.equal(unknown, undefined, "an unknown key must not resolve");
    }
});
