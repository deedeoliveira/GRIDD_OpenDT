import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { capabilitiesOf, hasAnyManagement } from "../../../front/lib/sessionCapabilities.mts";

const front = path.resolve(import.meta.dirname, "../../../front");
const read = (...p: string[]) => fs.readFileSync(path.join(front, ...p), "utf8");
const student = read("app/(viewer)/student/page.tsx");
const managerNav = read("app/(admin)/dashboard/ManagerNavigation.tsx");
const dashboard = read("app/(admin)/dashboard/page.tsx");
const reservations = read("app/(admin)/dashboard/reservations/page.tsx");
const backRoot = path.resolve(import.meta.dirname, "../..");
const managerRoute = fs.readFileSync(path.join(backRoot, "routes/managerReservations.ts"), "utf8");

test("the reservation-management workspace is user-labelled 'Gestão de reservas', not 'Gestão operacional'", () => {
  // (1) landing card and (2) management navigation
  assert.match(dashboard, />Gestão de reservas</);
  assert.match(managerNav, />Gestão de reservas</);
  // (3) no top-level management workspace label still says 'Gestão operacional'
  assert.doesNotMatch(dashboard, /Gestão operacional/);
  assert.doesNotMatch(managerNav, /Gestão operacional/);
});

test("the resource-reservation workspace is role-neutral (no student-only identity)", () => {
  // (4) no 'Área do estudante' / 'Workspace do estudante' workspace label
  assert.doesNotMatch(student, /Área do estudante|Workspace do estudante/);
  // (5) role-neutral header label
  assert.match(student, /Reservar recursos/);
  // the page never claims the current user is necessarily a student and never
  // uses applicationArea as an authority
  assert.doesNotMatch(student, /applicationArea/);
});

test("'Voltar à gestão' is capability-gated from the server-resolved session and targets /dashboard", () => {
  // capabilities are read from the single session response, not a second request
  assert.match(student, /setCapabilities\(capabilitiesOf\(session\)\)/);
  // (6/7/8) the return action is gated on hasAnyManagement(capabilities) — true
  // for bimManagement OR operationalManagement, false otherwise (see behavioural
  // assertions below). It is passed to both headers.
  assert.match(student, /backToManagement=\{hasAnyManagement\(capabilities\)\}/);
  // (9) the gated link targets /dashboard, in both the landing and workspace headers
  const gated = student.match(/backToManagement && <a[^>]*href="\/dashboard">Voltar à gestão<\/a>/g) ?? [];
  assert.equal(gated.length, 2, "both /student headers render a gated 'Voltar à gestão' link to /dashboard");
});

test("behavioural: hasAnyManagement decides the return action from capabilities", () => {
  // (6) bim-only, (7) operational-only -> visible; (8) neither -> hidden
  assert.equal(hasAnyManagement({ reserveResources: true, bimManagement: true, operationalManagement: false }), true);
  assert.equal(hasAnyManagement({ reserveResources: true, bimManagement: false, operationalManagement: true }), true);
  assert.equal(hasAnyManagement({ reserveResources: true, bimManagement: false, operationalManagement: false }), false);
  // capabilitiesOf reflects the server-resolved session capabilities verbatim
  assert.deepEqual(capabilitiesOf({ capabilities: { reserveResources: true, bimManagement: true, operationalManagement: false } }),
    { reserveResources: true, bimManagement: true, operationalManagement: false });
  assert.equal(hasAnyManagement(capabilitiesOf({ capabilities: { reserveResources: true, bimManagement: false, operationalManagement: false } })), false);
});

test("(10) internal role/capability identifiers and routes are unchanged", () => {
  // capability identifiers unchanged in the UI logic
  assert.match(managerNav, /capabilities\.operationalManagement/);
  assert.match(dashboard, /capabilities\.operationalManagement/);
  // internal API contract and route unchanged
  assert.match(managerRoute, /operationalManagement/);
  assert.match(managerRoute, /operational_management_required/);
  assert.match(managerNav, /href="\/dashboard\/reservations"/);
  // the page-specific heading may remain: it describes the concrete page contents
  assert.match(reservations, /Reservas e decisões/);
});
