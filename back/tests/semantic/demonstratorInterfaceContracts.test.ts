import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../../front");
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf8");
const login = read("app/login/page.tsx");
const managerNav = read("app/(admin)/dashboard/ManagerNavigation.tsx");
const manager = read("app/(admin)/dashboard/reservations/page.tsx");
const student = read("app/(viewer)/student/page.tsx");
const intake = read("app/(admin)/dashboard/page.tsx");
const formatter = read("lib/lisbonDateTime.ts");

test("navigation is resolved from server-derived capabilities and separates the three workspaces", () => {
  // Login routes by capabilities, not by the applicationArea alias.
  assert.match(login, /capabilitiesOf/); assert.match(login, /hasAnyManagement/); assert.match(login, /"\/dashboard"/); assert.match(login, /"\/student"/);
  // Management nav requires a management capability and derives its links from capabilities.
  assert.match(managerNav, /hasAnyManagement/); assert.match(managerNav, /"\/student"/);
  assert.match(managerNav, /capabilities\.bimManagement/); assert.match(managerNav, /capabilities\.operationalManagement/);
  // Managers are no longer redirected away from the reservation workspace.
  assert.doesNotMatch(student, /applicationArea === "manager"/);
  assert.doesNotMatch(student, /window\.location\.assign\("\/dashboard"\)/);
});

test("dashboard cards and page guards are derived from explicit capabilities", () => {
  // The landing chooser offers Reservar recursos always and the two management
  // cards only for the matching capability.
  assert.match(intake, /Reservar recursos/); assert.match(intake, /Gestão BIM/); assert.match(intake, /Gestão operacional/);
  assert.match(intake, /capabilities\.bimManagement &&/); assert.match(intake, /capabilities\.operationalManagement &&/);
  // A BIM-only account cannot load the operational page and vice-versa (capability guards).
  assert.match(intake, /!derived\.bimManagement/);
  assert.match(manager, /derived\.operationalManagement/); assert.match(manager, /setAuthorized\(true\)/);
  // Both management pages resolve the session first and handle 401 and rejected
  // fetches by redirecting to /login (no misleading workspace state, no flash).
  for (const page of [intake, manager]) {
    assert.match(page, /status === 401[^\n]*"\/login"/);
    assert.match(page, /\.catch\(\(\) => \{ if \(!cancelled\) window\.location\.assign\("\/login"\)/);
  }
});

test("demonstrator UI requires a model selection before showing its intake workspace", () => {
  assert.match(intake, /Selecionar modelo/); assert.match(intake, /<optgroup/); assert.match(intake, /selected && intakeOpen/);
  assert.doesNotMatch(intake, /context\?\.models\.map\(\(model\) => <article/);
  assert.match(manager, /Abrir/); assert.match(manager, /Cancelar/);
  assert.match(manager, /Detalhes/); assert.match(intake, /Detalhes/);
  assert.doesNotMatch(intake, /buildingId|createBuilding|Cadastrar/i);
});

test("visible dates use the Europe/Lisbon presentation timezone while APIs remain unchanged", () => {
  assert.match(formatter, /timeZone: "Europe\/Lisbon"/); assert.match(student, /formatLisbonDateTime/); assert.match(manager, /formatLisbonDateTime/);
});
