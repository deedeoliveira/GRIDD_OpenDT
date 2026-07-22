import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const front = path.resolve(import.meta.dirname, "../../../front");
const read = (...parts: string[]) => fs.readFileSync(path.join(front, ...parts), "utf8");
const readBack = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, "../..", ...parts), "utf8");
const globals = read("app/globals.css");
const login = read("app/login/page.tsx");
const student = read("app/(viewer)/student/page.tsx");
const viewer = read("app/(viewer)/student/Viewer.tsx");
const hiddenEye = read("app/components/icons/eye-hidden.tsx");
const managerNav = read("app/(admin)/dashboard/ManagerNavigation.tsx");
const managerReservations = read("app/(admin)/dashboard/reservations/page.tsx");
const reservationModal = read("app/(viewer)/student/ReservationModal.tsx");
const managerDashboard = read("app/(admin)/dashboard/page.tsx");
const assetProxy = read("app/api/asset/[...path]/route.ts");
const layout = read("app/layout.tsx");
const persistentAssets = readBack("utils/persistentAssetDatabase.ts");
const catalogueAssets = readBack("utils/nonModelledAssetDatabase.ts");
const assetRoute = readBack("routes/asset.ts");

test("institutional visual language has centrally defined accessible UMinho tokens", () => {
  for (const token of ["--uminho-primary", "--uminho-primary-dark", "--uminho-primary-light", "--uminho-accent", "--surface", "--surface-muted", "--text-primary", "--text-secondary", "--border", "--focus"]) assert.match(globals, new RegExp(token));
  assert.match(globals, /:focus-visible/);
  assert.match(managerNav, /uminho-nav/);
  assert.match(managerReservations, /uminho-page/);
  assert.doesNotMatch(layout, /next\/font|google/i);
});

test("local login retains server account routing and adds only visual numbering", () => {
  assert.match(login, /Plataforma de Gestão de Edifícios/);
  assert.match(login, /Universidade do Minho/);
  assert.match(login, /autenticação é local e destinada à demonstração/);
  assert.match(login, /accounts\.map\(\(account, index\)/);
  assert.match(login, /index \+ 1/);
  assert.match(login, /login\(account\.accountKey\)/);
});

test("student chooses one of three isolated workspaces", () => {
  assert.match(student, /type StudentMode = "model" \| "catalogue" \| "manage" \| null/);
  assert.match(student, /useState<StudentMode>\(null\)/);
  for (const label of ["Reservar através do modelo", "Reservar sem modelo", "Gerir reservas"]) assert.match(student, new RegExp(label));
  assert.match(student, /mode === "model"/);
  assert.match(student, /mode === "catalogue"/);
  assert.match(student, /mode === "manage"/);
  assert.match(student, /\/api\/asset\/persistent\/reservable/);
  assert.match(assetProxy, /\/asset\/\$\{path\.map\(encodeURIComponent\)\.join\("\/"\)\}/);
  assert.match(catalogueAssets, /listStudentReservableAssets/);
  assert.match(persistentAssets, /getStudentAssetByCurrentBinding/);
  assert.match(assetRoute, /requireStudent/);
  assert.doesNotMatch(student, /AccordionItem|fixed inset-0/);
});

test("IFC tree visibility has distinct accessible eye controls and redraws immediately", () => {
  assert.match(viewer, /EyeVisible/); assert.match(viewer, /EyeHidden/);
  assert.match(viewer, /data-visibility-state/); assert.match(viewer, /aria-pressed=\{!allHidden\}/);
  assert.match(viewer, /components\.get\(OBC\.Hider\)\.set\(nextVisible/); assert.match(viewer, /fragments\.core\.update\(true\)/);
  assert.match(viewer, /typeof node\.data\.localId === "number"/); assert.match(viewer, /data-tree-select/);
  assert.match(viewer, /new ResizeObserver/); assert.match(viewer, /lg:grid-cols-\[minmax\(17rem,22rem\)_minmax\(0,1fr\)\]/);
  assert.match(hiddenEye, /M2\.39 1\.73L1\.11 3/);
});

test("both reservation entry points use one accessible dialog and reservation groups start collapsed", () => {
  assert.match(reservationModal, /role="dialog"/); assert.match(reservationModal, /aria-modal="true"/);
  assert.match(reservationModal, /event\.key === "Escape"/); assert.match(reservationModal, /previousFocus\?\.focus/);
  assert.match(reservationModal, /event\.key !== "Tab"/); assert.match(reservationModal, /sourceContext/);
  assert.match(student, /presentation="dialog"/); assert.match(student, /model-start-reservation/); assert.match(student, /useState<string \| null>\(null\)/);
  assert.match(student, /aria-expanded=\{open\}/); assert.match(student, /aria-controls=\{`reservation-group-/);
});

test("the selected resource panel precedes the viewer and keeps the model selection compact", () => {
  const panel = student.indexOf("<SelectedResourcePanel");
  const viewer = student.indexOf("<Viewer key={viewerKey}");
  assert.ok(panel >= 0 && viewer >= 0 && panel < viewer, "the selected-resource panel must be rendered before the viewer");
  assert.match(student, /data-testid="selected-resource-panel"/);
  assert.match(student, /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(19rem,25rem\)\]/);
  assert.match(student, /Carregue um modelo e selecione um elemento para iniciar um pedido/);
  assert.match(student, /Localização: \{asset\.location\.name/);
});

test("manager starts with an explicit workspace choice and uses accessible evidence banners", () => {
  assert.match(managerDashboard, /O que pretende gerir\?/); assert.match(managerDashboard, /workspaceSelected/);
  assert.match(managerDashboard, /searchParams\.set\("workspace", "models"\)/); assert.match(managerReservations, /uminho-banner-success/);
  assert.match(managerReservations, /uminho-banner-warning/); assert.match(globals, /\.uminho-banner-error/);
});
