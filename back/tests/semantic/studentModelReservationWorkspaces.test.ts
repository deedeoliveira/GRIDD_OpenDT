import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const student = read("front/app/(viewer)/student/page.tsx");
const viewer = read("front/app/(viewer)/student/Viewer.tsx");
const modelRoute = read("back/routes/model.ts");
const modelDb = read("back/utils/modelDatabase.ts");
const modelContextProxy = read("front/app/api/model/student-contexts/route.ts");
const versionProxy = read("front/app/api/model/version/[versionId]/download/route.ts");
const assetRoute = read("back/routes/asset.ts");
const assetDb = read("back/utils/persistentAssetDatabase.ts");
const catalogueDb = read("back/utils/nonModelledAssetDatabase.ts");
const reservationRoute = read("back/routes/reservation.ts");
const reservationModal = read("front/app/(viewer)/student/ReservationModal.tsx");
const managerNav = read("front/app/(admin)/dashboard/ManagerNavigation.tsx");

test("model selection keeps linked context, logical line and current version as distinct fields", () => {
  for (const field of ["modelLineId", "linkedModelId", "currentVersionId"]) { assert.match(modelDb, new RegExp(field)); assert.match(student, new RegExp(field)); }
  assert.match(student, /String\(item\.modelLineId\) === selectedModelLineId/);
  assert.match(student, /String\(item\.modelLineId\) === value/);
  assert.doesNotMatch(student, /item\.id === event\.target\.value/);
});

test("current version download preserves session, backend status and authorization", () => {
  assert.match(viewer, /selectedModel\.currentVersionId/);
  assert.match(viewer, /\/api\/model\/version\/\$\{selectedModel\.currentVersionId\}\/download/);
  assert.match(versionProxy, /headers\.set\("cookie", cookie\)/);
  assert.match(versionProxy, /status: response\.status/);
  assert.match(modelRoute, /requireWorkspace\(req, res, \["student", "manager"\]\)/);
  assert.match(modelContextProxy, /cache: "no-store"/);
});

test("viewer validates the real response, enters loaded state and constructs the IFC tree", () => {
  assert.match(viewer, /if \(!response\.ok\)/);
  assert.match(viewer, /contentType\.includes\("application\/json"\)/);
  assert.match(viewer, /if \(!bytes\.byteLength\)/);
  assert.match(viewer, /ifcLoader\.load/);
  assert.match(viewer, /getSpatialStructure/);
  assert.match(viewer, /onTreeStateChange\?\.\(trees\.length\)/);
  assert.match(viewer, /onLoadStateChange\?\.\("loaded"\)/);
});

test("switching model or workspace clears transient viewer and reservation state", () => {
  for (const expression of [/setViewerContext\(null\)/, /setSelectedIfc\(null\)/, /setSelectedAsset\(null\)/, /setReservationOpen\(false\)/]) assert.match(student, expression);
  assert.match(viewer, /disposeModel/);
  assert.match(viewer, /loadGenerationRef\.current/);
});

test("no current version never mounts a viewer and failed history is sanitized", () => {
  assert.match(student, /selectedContext\?\.currentVersionId/);
  assert.match(student, /loadState === "no_current"/);
  assert.match(student, /loadState === "failed"/);
  assert.match(modelDb, /\[path removed\]/);
  assert.match(modelDb, /slice\(0, 240\)/);
});

test("only a current persistent binding makes an IFC element reservable", () => {
  assert.match(student, /persistent\/current-binding/);
  assert.match(assetDb, /getStudentAssetByCurrentBinding/);
  assert.match(assetDb, /ab\.model_version_id = m\.current_version_id/);
  assert.match(assetDb, /ab\.ifc_guid = :ifcGuid/);
  assert.match(assetDb, /a\.lifecycle_status = 'active' AND a\.reservable = 1/);
});

test("global catalogue is session-bound, read-only, deduplicated and classified", () => {
  assert.match(assetRoute, /app\.get\("\/persistent\/reservable"/);
  assert.match(assetRoute, /requireStudent\(req, res\)/);
  assert.match(catalogueDb, /ROW_NUMBER\(\) OVER \(PARTITION BY ab\.asset_id/);
  assert.match(catalogueDb, /WHEN cb\.asset_id IS NOT NULL THEN 'modelled'/);
  assert.match(catalogueDb, /a\.source = 'graph' AND a\.semantic_uri IS NOT NULL THEN 'non_modelled'/);
  assert.match(catalogueDb, /ELSE 'undetermined'/);
  assert.match(catalogueDb, /:modelLineId IS NULL OR cb\.model_line_id = :modelLineId/);
});

test("catalogue has one normalized search and separate representation groups", () => {
  assert.equal((student.match(/type="search"/g) ?? []).length, 1);
  assert.match(student, /trim\(\)\.toLocaleLowerCase\("pt"\)/);
  for (const label of ["Ativos modelados", "Ativos não modelados", "Localização não registada", "Nenhum ativo corresponde à pesquisa"]) assert.match(student, new RegExp(label));
});

test("browser uses persistent UUID and backend resolves the operational ID", () => {
  assert.match(catalogueDb, /persistentAssetId: String\(row\.asset_uuid\)/);
  assert.match(assetDb, /resolveReservableAssetId/);
  assert.match(reservationRoute, /persistentAssetId/);
  assert.match(reservationRoute, /const assetId = await reservationAssetId\(req\.body\)/);
  assert.match(reservationModal, /assetTarget/);
});

test("reservation management stays separate and retains lifecycle actions", () => {
  assert.match(student, /A criação de novos pedidos pertence aos outros dois workspaces/);
  for (const label of ["Cancelar pedido", "Check-in", "Checkout", "DecisionDetails"]) assert.match(student, new RegExp(label));
});

test("viewer selection works from the canvas and keyboard-accessible IFC tree", () => {
  assert.match(viewer, /container\.current\.addEventListener\("click"/);
  assert.match(viewer, /data-tree-select/); assert.match(viewer, /selectItems\(\{ \[node\.data\.modelId\]/);
  assert.match(student, /O elemento selecionado não representa um equipamento reservável/);
  assert.match(student, /binding corrente para um ativo persistente reservável/);
});

test("model selection opens the same request dialog instead of an inline reservation form", () => {
  assert.match(student, /data-testid="selected-resource-panel"/);
  assert.match(student, /data-testid="model-start-reservation"/);
  assert.match(student, /<ReservationModal presentation="dialog" asset=\{asset\}/);
  assert.match(student, /sourceContext=\{modelContext\}/);
  assert.match(student, /startRequestRef\.current\?\.focus\(\)/);
  assert.match(reservationModal, /\/api\/reservation\/evidence/);
  assert.match(reservationModal, /\/api\/reservation\/request/);
  assert.match(reservationModal, /Selecionado através do modelo/);
});

test("manager navigation exposes the two existing workspaces", () => {
  assert.match(managerNav, />Gerir modelos</);
  assert.match(managerNav, />Reservas e decisões</);
  assert.match(managerNav, /href="\/dashboard"/);
  assert.match(managerNav, /href="\/dashboard\/reservations"/);
});
