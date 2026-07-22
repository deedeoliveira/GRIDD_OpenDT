import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chromePath = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const baseUrl = process.env.FRONTEND_BASE_URL ?? "http://localhost:3000";
const port = Number(process.env.CHROME_DEBUG_PORT ?? 9337);
const profile = mkdtempSync(join(tmpdir(), "oswadt-browser-smoke-"));
const chrome = spawn(chromePath, ["--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `${baseUrl}/login`], { stdio: "ignore" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 45_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try { const value = await fn(); if (value) return value; } catch (error) { lastError = error; }
    await sleep(250);
  }
  throw new Error(`Timeout while waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

let socket;
let sequence = 0;
const pending = new Map();
const browserErrors = [];
function command(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools command timed out: ${method}`)); }, 15_000);
    pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
  });
}
async function evaluate(expression) {
  const response = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}
async function navigate(path) {
  await command("Page.navigate", { url: `${baseUrl}${path}` });
  await waitFor(() => evaluate("document.readyState === 'complete'"), `navigation to ${path}`);
}
async function textExists(text) {
  return evaluate(`document.body?.innerText.includes(${JSON.stringify(text)})`);
}

try {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    return targets.find((item) => item.type === "page");
  }, "Chrome DevTools endpoint");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") browserErrors.push(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text ?? "browser exception");
    if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params?.type)) browserErrors.push(message.params.args?.map((arg) => arg.value ?? arg.description).join(" ") ?? message.params.type);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id); pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  await command("Page.enable"); await command("Runtime.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await navigate("/login");

  const studentLogin = await evaluate(`fetch('/api/auth/local-login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accountKey:'pg202404'})}).then(async r=>({ok:r.ok,status:r.status,body:await r.text()}))`);
  assert.equal(studentLogin.ok, true, `student login failed: ${studentLogin.status} ${studentLogin.body}`);
  await navigate("/student?mode=model");
  await waitFor(() => textExists("Logical model line"), "student model workspace");
  await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('select option')].find(o=>o.value))`), "available model line");
  const chosenModelLine = await evaluate(`(()=>{const select=document.querySelector('select');const option=[...select.options].find(o=>o.value);if(!option)return null;select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));return option.value})()`);
  assert.ok(chosenModelLine, "no model line was available");
  await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('button')].find(b=>b.textContent.includes('Carregar modelo')))`), "model load action");
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Carregar modelo')).click()`);
  try {
    await waitFor(() => evaluate(`document.querySelectorAll('[data-tree-select]').length > 0 && document.querySelectorAll('canvas').length > 0`), "interactive IFC tree and canvas", 30_000);
  } catch (error) {
    const diagnostic = await evaluate(`({text:document.body?.innerText,canvas:document.querySelectorAll('canvas').length,tree:document.querySelectorAll('[data-tree-select]').length,html:document.querySelector('main')?.innerHTML.slice(0,2000)})`);
    throw new Error(`${error.message}\nBrowser diagnostic: ${JSON.stringify(diagnostic)}\nBrowser errors: ${JSON.stringify(browserErrors)}`);
  }

  const layout = await evaluate(`(()=>{const tree=document.querySelector('[data-testid="ifc-tree-scroll"]').closest('aside').getBoundingClientRect();const viewer=document.querySelector('[data-testid="ifc-viewer-panel"]').getBoundingClientRect();const canvas=document.querySelector('[data-testid="ifc-viewer-panel"] canvas')?.getBoundingClientRect();return {tree:{top:tree.top,bottom:tree.bottom,right:tree.right},viewer:{top:viewer.top,bottom:viewer.bottom,left:viewer.left,width:viewer.width,height:viewer.height},canvas:canvas&&{width:canvas.width,height:canvas.height}}})()`);
  assert.ok(layout.viewer.height >= 400 && layout.canvas?.width > 300 && layout.canvas?.height > 300, "viewer canvas is not stably visible");
  assert.ok(Math.abs(layout.tree.top - layout.viewer.top) < 8 && layout.tree.right <= layout.viewer.left + 4, `tree and viewer are not side by side: ${JSON.stringify(layout)}`);

  const viewerRect = await evaluate(`(()=>{const rect=document.querySelector('[data-testid="ifc-viewer-panel"] canvas').getBoundingClientRect();return {left:rect.left,top:rect.top,width:rect.width,height:rect.height}})()`);
  let canvasSelected = false;
  for (const yRatio of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    for (const xRatio of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
      const x = viewerRect.left + viewerRect.width * xRatio; const y = viewerRect.top + viewerRect.height * yRatio;
      await command("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await command("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await command("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      await sleep(100);
      if (!await textExists("Selecione um elemento no modelo ou na árvore IFC.")) { canvasSelected = true; break; }
    }
    if (canvasSelected) break;
  }
  if (!canvasSelected) {
    const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const screenshotPath = join(tmpdir(), "oswadt-viewer-smoke.png");
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
    const viewerDiagnostics = await evaluate(`document.querySelector('[aria-label="Visualizador tridimensional IFC"]')?.dataset.viewerDiagnostics`);
    assert.fail(`clicking the rendered IFC canvas did not select a model element: ${JSON.stringify(browserErrors)}; viewer=${viewerDiagnostics}; screenshot=${screenshotPath}`);
  }

  const visibilityBefore = await evaluate(`document.querySelector('[data-visibility-state]').getAttribute('aria-pressed')`);
  await evaluate(`document.querySelector('[data-visibility-state]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[data-visibility-state]').getAttribute('aria-pressed') !== ${JSON.stringify(visibilityBefore)}`), "eye control state change");
  const visibilityAfter = await evaluate(`document.querySelector('[data-visibility-state]').getAttribute('aria-pressed')`);
  assert.notEqual(visibilityBefore, visibilityAfter, "eye control did not change visibility state");
  await evaluate(`document.querySelector('[data-visibility-state]').click()`);
  await waitFor(() => evaluate(`document.querySelector('[data-visibility-state]').getAttribute('aria-pressed') === ${JSON.stringify(visibilityBefore)}`), "eye control state restoration");

  const selectedGuid = await evaluate(`(async()=>{for(const button of document.querySelectorAll('[data-tree-select]')){const guid=button.dataset.ifcGuid;if(!guid)continue;const response=await fetch('/api/asset/persistent/current-binding/${chosenModelLine}/'+encodeURIComponent(guid));if(response.ok){button.click();return guid;}}document.querySelector('[data-tree-select]')?.click();return null;})()`);
  await waitFor(() => evaluate(`!document.body.innerText.includes('A resolver o binding corrente')`), "selected resource resolution");
  const selection = await evaluate(`({guid:${JSON.stringify(selectedGuid)},text:document.body.innerText})`);
  assert.ok(selection.text.includes("Recurso selecionado") && !selection.text.includes("A resolver o binding corrente"), `tree selection did not update the selected resource panel: ${JSON.stringify(selection)}`);
  const resourcePanelLayout = await evaluate(`(()=>{const panel=document.querySelector('[data-testid="selected-resource-panel"]').getBoundingClientRect();const viewer=document.querySelector('[data-testid="ifc-viewer-panel"]').getBoundingClientRect();return {panel:{top:panel.top,bottom:panel.bottom},viewer:{top:viewer.top,bottom:viewer.bottom}}})()`);
  assert.ok(resourcePanelLayout.panel.bottom <= resourcePanelLayout.viewer.top + 8, `selected resource panel is not before the viewer: ${JSON.stringify(resourcePanelLayout)}`);
  assert.equal(await evaluate(`document.querySelector('[data-testid="selected-resource-panel"] input[type="date"]') === null`), true, "the model resource panel rendered the request form inline");
  await evaluate(`document.querySelector('[data-testid="model-start-reservation"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))`), "model reservation dialog");
  assert.equal(await evaluate(`document.querySelector('[role="dialog"] [data-testid="model-reservation-context"]')?.textContent.includes('Selecionado através do modelo')`), true, "model context is not shown in the shared reservation dialog");
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await waitFor(() => evaluate(`!document.querySelector('[role="dialog"]')`), "model dialog close with Escape");
  assert.equal(await evaluate(`document.activeElement?.dataset?.testid === 'model-start-reservation'`), true, "focus did not return to the model request action");
  await evaluate(`document.querySelector('[data-testid="model-start-reservation"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))`), "model reservation dialog reopening");
  await evaluate(`document.querySelector('button[aria-label="Fechar pedido de reserva"]').click()`);
  await waitFor(() => evaluate(`!document.querySelector('[role="dialog"]')`), "model dialog close button");

  const nonReservableGuid = await evaluate(`(async()=>{for(const button of document.querySelectorAll('[data-tree-select]')){const guid=button.dataset.ifcGuid;if(!guid)continue;const response=await fetch('/api/asset/persistent/current-binding/${chosenModelLine}/'+encodeURIComponent(guid));if(response.status===404){button.click();return guid;}}return null;})()`);
  assert.ok(nonReservableGuid, "no non-reservable IFC element was available for the smoke test");
  await waitFor(() => evaluate(`/não representa um equipamento reservável|não possui um binding corrente/.test(document.body.innerText)`), "explicit non-reservable IFC message");
  assert.equal(await evaluate(`document.querySelector('[data-testid="model-start-reservation"]') === null && document.querySelector('[role="dialog"]') === null`), true, "a non-reservable element offered a reservation dialog");

  await evaluate(`[...document.querySelectorAll('[role="tab"]')].find(b=>b.textContent.includes('Reservar sem modelo')).click()`);
  await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('button')].find(b=>b.textContent.includes('Selecionar ativo')))`), "catalogue assets");
  await evaluate(`(()=>{const input=document.querySelector('input[type="search"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'a');input.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Selecionar ativo')).click()})()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))`), "reservation dialog");
  const dialogState = await evaluate(`(()=>{const dialog=document.querySelector('[role="dialog"]');return {focused:dialog.contains(document.activeElement),search:document.querySelector('input[type="search"]').value}})()`);
  assert.equal(dialogState.focused, true, "reservation dialog did not receive focus");
  assert.equal(dialogState.search, "a", "catalogue search was not preserved");
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await waitFor(() => evaluate(`!document.querySelector('[role="dialog"]')`), "dialog close with Escape");
  assert.equal(await evaluate(`document.activeElement?.textContent?.includes('Selecionar ativo')`), true, "focus did not return to the catalogue action");
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Selecionar ativo')).click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))`), "reservation dialog reopening");
  await evaluate(`document.querySelector('button[aria-label="Fechar pedido de reserva"]').click()`);
  await waitFor(() => evaluate(`!document.querySelector('[role="dialog"]')`), "dialog close button");

  await evaluate(`[...document.querySelectorAll('[role="tab"]')].find(b=>b.textContent.includes('Gerir reservas')).click()`);
  await waitFor(() => textExists("Pendentes"), "reservation groups");
  const accordion = await evaluate(`(()=>{const buttons=[...document.querySelectorAll('button[aria-controls^="reservation-group-"]')];const initial=buttons.every(b=>b.getAttribute('aria-expanded')==='false');buttons[0].click();return {count:buttons.length,initial}})()`);
  await waitFor(() => evaluate(`document.querySelector('button[aria-controls^="reservation-group-"]').getAttribute('aria-expanded')==='true'`), "reservation accordion opening");
  assert.equal(accordion.count, 6); assert.equal(accordion.initial, true);
  await evaluate(`document.querySelector('button[aria-controls^="reservation-group-"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('button[aria-controls^="reservation-group-"]').getAttribute('aria-expanded')==='false'`), "reservation accordion closing");
  await evaluate(`[...document.querySelectorAll('button[aria-controls^="reservation-group-"]')].at(-1).click()`);
  await waitFor(() => evaluate(`[...document.querySelectorAll('button[aria-controls^="reservation-group-"]')].at(-1).getAttribute('aria-expanded')==='true'`), "cancelled reservation accordion opening");

  await evaluate(`[...document.querySelectorAll('[role="tab"]')].find(b=>b.textContent.includes('Reservar através do modelo')).click()`);
  await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('select option')].find(o=>o.value))`), "model line after returning to viewer workspace");
  assert.equal(await evaluate(`![...document.querySelectorAll('button')].some(b=>b.textContent.includes('Carregar modelo'))`), true, "the model selection was retained after leaving its workspace");
  await evaluate(`(()=>{const select=document.querySelector('select');const option=[...select.options].find(o=>o.value);select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await waitFor(() => evaluate(`Boolean([...document.querySelectorAll('button')].find(b=>b.textContent.includes('Carregar modelo')))`), "model load after returning to viewer workspace");
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Carregar modelo')).click()`);
  await waitFor(() => evaluate(`document.querySelectorAll('[data-tree-select]').length > 0 && document.querySelectorAll('canvas').length > 0`), "functional viewer after workspace return", 45_000);

  await evaluate(`fetch('/api/auth/logout',{method:'POST'})`);
  await navigate("/login");
  const managerLogin = await evaluate(`fetch('/api/auth/local-login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accountKey:'manager-demo-001'})}).then(async r=>({ok:r.ok,status:r.status,body:await r.text()}))`);
  assert.equal(managerLogin.ok, true, `manager login failed: ${managerLogin.status} ${managerLogin.body}`);
  await navigate("/dashboard");
  await waitFor(() => textExists("O que pretende gerir?"), "manager workspace choice");
  assert.equal(await textExists("Selecionar modelo"), false, "model workspace opened before the manager chose it");
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Gerir modelos')).click()`);
  await waitFor(() => textExists("Selecionar modelo"), "manager model workspace after explicit choice");
  await evaluate(`[...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='Início').click()`);
  await waitFor(() => textExists("O que pretende gerir?"), "return to manager workspace choice");
  await evaluate(`[...document.querySelectorAll('a')].find(a=>a.textContent.includes('Reservas e decisões')).click()`);
  await waitFor(() => textExists("Reservas e decisões"), "manager reservation workspace");
  await waitFor(() => evaluate(`Boolean(document.querySelector('.uminho-banner'))`), "manager evidence banner");
  const bannerContrast = await evaluate(`(()=>{const element=document.querySelector('.uminho-banner');const style=getComputedStyle(element);const parse=c=>{const m=c.match(/[\\d.]+/g).slice(0,3).map(Number);return m.map(v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)})};const lum=c=>{const [r,g,b]=parse(c);return .2126*r+.7152*g+.0722*b};const a=lum(style.color),b=lum(style.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)})()`);
  assert.ok(bannerContrast >= 4.5, `manager banner contrast is insufficient: ${bannerContrast}`);

  const reactErrors = browserErrors.filter((entry) => /hydration|same key|client-side exception/i.test(entry));
  assert.deepEqual(reactErrors, [], `React reported browser errors: ${JSON.stringify(reactErrors)}`);

  console.log(JSON.stringify({ ok: true, checks: ["viewer_layout", "viewer_canvas_selection", "eye_interaction", "tree_selection", "resource_panel_before_viewer", "model_reservation_dialog", "non_reservable_message", "viewer_workspace_return", "accessible_modal_reopen", "collapsed_accordions", "manager_workspace_alternation", "manager_banner_contrast"], reservationsCreated: 0, modelVersionsCreated: 0 }, null, 2));
} finally {
  try { socket?.close(); } catch {}
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
