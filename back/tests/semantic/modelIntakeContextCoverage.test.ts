import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const database = fs.readFileSync(path.join(root, "utils/modelIntakeDatabase.ts"), "utf8");
const service = fs.readFileSync(path.join(root, "modelIntake/modelIntakeService.ts"), "utf8");
const route = fs.readFileSync(path.join(root, "routes/modelIntake.ts"), "utf8");
const dashboard = fs.readFileSync(path.resolve(import.meta.dirname, "../../../front/app/(admin)/dashboard/page.tsx"), "utf8");
const proxy = fs.readFileSync(path.resolve(import.meta.dirname, "../../../front/app/api/model-intake/[...path]/route.ts"), "utf8");

test("model context retains logical model lines without a current version and counts their history", () => {
  assert.match(database, /LEFT JOIN model_versions v ON v\.id = m\.current_version_id/);
  assert.match(database, /COUNT\(\*\) AS version_count/);
  assert.doesNotMatch(database, /WHERE\s+m\.current_version_id\s+IS\s+NOT\s+NULL/i);
  assert.match(service, /no_active_version/); assert.match(service, /no_current_version/); assert.match(service, /canCreateVersion: true/);
  assert.match(database, /latest_version_status/); assert.match(service, /safeLatestFailure/); assert.match(service, /latestVersion/);
});

test("model intake context is manager-session protected and dashboard distinguishes duplicate names by parent context", () => {
  assert.match(route, /requireManagerWorkspace/); assert.match(route, /applicationArea/); assert.match(route, /workspace is available only to a scoped reservation manager/i);
  assert.match(proxy, /request\.headers\.get\("cookie"\)/); assert.match(proxy, /requestHeaders\.set\("cookie", cookie\)/);
  assert.match(dashboard, /Contexto do modelo:/); assert.match(dashboard, /Adicionar primeira versão/); assert.match(dashboard, /Adicionar nova versão/); assert.match(dashboard, /A tentativa mais recente não foi ativada porque o processamento falhou/);
  assert.match(dashboard, /useState\(""\)/); assert.match(dashboard, /<option value="">Selecionar modelo<\/option>/);
  assert.match(dashboard, /<optgroup label="Modelos com versão ativa">/); assert.match(dashboard, /<optgroup label="Modelos sem versão ativa">/);
  assert.match(dashboard, /linha \$\{model\.model_id\}/); assert.match(dashboard, /selected && intakeOpen/);
  assert.match(dashboard, /setIfcFile\(null\).*setIdsFile\(null\).*setIdsMode\(""\).*setShapesFile\(null\)/);
});

test("dashboard does not render a detail card for every model line", () => {
  assert.doesNotMatch(dashboard, /context\?\.models\.map\(\(model\) => <article/);
});
