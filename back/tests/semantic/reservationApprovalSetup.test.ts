import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const setup = fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/reservationApprovalSetup.ts'), 'utf8');

test('reservation approval setup prepares the second synthetic student as a verified current-dataset link', () => {
  assert.match(setup, /pg202405/);
  assert.match(setup, /TestStudentPhD002/);
  assert.match(setup, /createVerifiedLink/);
  assert.match(setup, /bindCurrentLink/);
  assert.match(setup, /resolveCurrentInstitutionalDataset/);
});
