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

test("role navigation is resolved from the server session and keeps student and manager areas separate", () => {
  assert.match(login, /applicationArea/); assert.match(login, /area === "manager"/); assert.match(login, /"\/dashboard"/);
  assert.match(managerNav, /session\?\.applicationArea !== "manager"/); assert.match(managerNav, /"\/student"/);
  assert.match(student, /applicationArea === "manager"/); assert.match(student, /"\/dashboard"/);
  assert.doesNotMatch(student, /\/dashboard\/reservations/);
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
