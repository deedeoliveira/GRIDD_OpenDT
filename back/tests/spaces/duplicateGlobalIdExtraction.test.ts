/**
 * ADR-0051 Stage 0B §1/§5A — REAL parser-level duplicate-GlobalId proof.
 *
 * Runs the ACTUAL Python/IfcOpenShell extraction (not a hand-built occurrence array)
 * over a fixture that contains two IfcSpace entities sharing the SAME exact GlobalId
 * (plus two case-different GlobalIds). It proves:
 *   - the GlobalId-keyed inventoryData collapses the duplicate to a single key;
 *   - the lossless spaceOccurrences list retains BOTH occurrences;
 *   - the pure activation preflight blocks on the duplicate BEFORE any persistence;
 *   - case-different GlobalIds remain DISTINCT (byte-exact identity).
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { installFakeMySQL } from "../helpers/fakeDb.ts";

// The identity service pulls in the spaces DB singleton at import time; install the
// fake so the module loads (the preflight itself is pure and touches no database).
installFakeMySQL();
const { extractIfcModelFromFile } = await import("../../requirements/ifcFileExtraction.ts");
const { preflightSpaceOccurrences, DuplicateSpaceGlobalIdError } = await import("../../services/spaceIdentityService.ts");
const { groupDuplicateGlobalIds } = await import("../../services/spatialPreflightService.ts");

const fixture = path.resolve(process.cwd(), "tests/fixtures/duplicate-space-globalid.ifc");
const DUP = "DUPGUIDSPACE0000000001";
const LOWER = "AAAAAAAAAAAAAAAAAAAA1a";
const UPPER = "AAAAAAAAAAAAAAAAAAAA1A";

test("real IfcOpenShell extraction retains both occurrences of a duplicate GlobalId (inventory collapses it)", async () => {
    const extracted = await extractIfcModelFromFile(fixture);

    // inventoryData is keyed by GlobalId → the duplicate collapses to ONE key.
    assert.equal(Object.keys(extracted.inventoryData).filter((g) => g === DUP).length, 1);

    // The lossless list keeps every IfcSpace occurrence: 2 duplicates + 2 case-different.
    assert.ok(Array.isArray(extracted.spaceOccurrences));
    const dupOccurrences = extracted.spaceOccurrences!.filter((o) => o.guid === DUP);
    assert.equal(dupOccurrences.length, 2, "both IfcSpace instances with the shared GlobalId are retained");
    // Distinct entity ids prove they are two real, separate entities.
    assert.notEqual(dupOccurrences[0]!.entityId, dupOccurrences[1]!.entityId);

    // Case-different GlobalIds are two distinct occurrences, never grouped as duplicates.
    const dup = groupDuplicateGlobalIds(extracted.spaceOccurrences!);
    assert.deepEqual([...dup.keys()], [DUP], "only the exact duplicate is grouped");
    assert.ok(extracted.spaceOccurrences!.some((o) => o.guid === LOWER));
    assert.ok(extracted.spaceOccurrences!.some((o) => o.guid === UPPER));
});

test("activation preflight blocks the real duplicate BEFORE any persistence", async () => {
    const extracted = await extractIfcModelFromFile(fixture);
    assert.throws(
        () => preflightSpaceOccurrences({ extracted, modelVersionId: 1, linkedModelId: 10 }),
        (e: any) => {
            assert.ok(e instanceof DuplicateSpaceGlobalIdError);
            assert.equal(e.code, "duplicate_candidate_globalid");
            assert.ok(e.diagnostics.some((d: any) => d.ifcGlobalId === DUP && d.candidateCount === 2));
            return true;
        });
});
