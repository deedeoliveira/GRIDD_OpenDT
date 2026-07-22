"use client";

import { useEffect, useMemo, useState } from "react";
import ManagerNavigation from "./ManagerNavigation";

type Context = {
  models: Array<{ model_id: number; model_uuid: string; model_name: string; linked_model_id: number; linked_model_name: string;
    current_version_id: number | null; current_version_number: number | null; current_ifc_hash: string | null;
    versionCount: number; state: "active" | "no_active_version" | "no_current_version"; canCreateVersion: boolean;
    latestVersion: { id: number; status: string; createdAt: string | null; failureStage: string | null; message: string | null } | null;
    linkedParent: { id: number; name: string } }>;
  activeIdsProfile: Profile;
  mappingProfile: { familyKey: string; version: string; sha256: string; status: string; artifactType: string };
  modes: { materialisation: string; temporaryIdsUploadEnabled: boolean };
  shacl: { enabled: boolean; mode: string; temporaryShapesUploadEnabled: boolean; governedShapes: Shapes | null };
};
type Requirement = { requirementId: string; specification: string; appliesTo: string; requires: string; cardinality: string; expectedPattern: string | null };
type Profile = { source: string; originalFilename: string; version: string; sha256: string; executorName: string; executorVersion: string;
  specificationCount: number; requirements: Requirement[] };
type Finding = { source: "ids" | "project_rule"; requirementId: string; requirementName: string; status: string; entityType: string | null;
  entityGuid: string | null; propertySet: string | null; propertyName: string | null; message: string };
type Space = { persistentUuid: string; reference: string; label: string | null; ifcGuid: string; ifcClass: string; storey: string | null;
  persistentUri: string; manifestationUri: string };
type Asset = { persistentUuid: string; tag: string; serialNumber: string | null; ifcGuid: string; ifcClass: string;
  containingSpace: string | null; persistentUri: string; manifestationUri: string };
type Run = { runUuid: string; modelId: number; ifc: { originalFilename: string; serverComputedSha256: string; byteSize: number;
  detectedIfcSchema: string; entityCounts: Record<string, number> }; ids: Profile;
  validation: { overallStatus: string; idsStatus: string; projectRulesStatus: string; blocking: boolean; findings: Finding[] };
  rdfPreview: { mappingProfile: string; mappingVersion: string; turtleSha256: string; tripleCount: number; spaceCount: number;
    assetCount: number; manifestationCount: number; warnings: string[]; spaces: Space[]; assets: Asset[]; sampleTriples: string[] } };
type Created = { versionId: number; versionUuid: string; versionNumber: number; previousCurrentVersion: number | null; newCurrentVersion: number;
  semanticMaterialisation: { status: string; namedGraphUri?: string; tripleCount?: number; spaceCount?: number; assetCount?: number;
    shaclValidation?: ShaclReport & { reportGraphUri?: string } } };
type Constraint = { sourceShape: string; nodeShape: string; targets: Array<{ kind: string; value: string }>; path: string | null;
  minCount: number | null; maxCount: number | null; datatype: string | null; class: string | null; nodeKind: string | null;
  pattern: string | null; severity: string; message: string | null };
type Shapes = { source: string; filename: string; familyKey: string | null; version: string | null; sha256: string;
  artifactId: number | null; namedGraphUri: string | null; constraints: Constraint[]; executorName: string; executorVersion: string };
type ShaclResult = { severity: string | null; focusNode: string | null; resultPath: string | null; value: string | null;
  sourceShape: string | null; sourceConstraintComponent: string | null; message: string | null };
type ShaclReport = { runUuid: string; conforms: boolean; resultCount: number; results: ShaclResult[]; dataGraphSha256: string;
  shapesGraphSha256: string; shapesSource: string; executorName: string; executorVersion: string; reportGraphUri: string | null };

const box = "rounded-2xl border border-slate-800 bg-slate-900 p-6";
const input = "mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 file:mr-4 file:rounded-lg file:border-0 file:bg-cyan-500 file:px-3 file:py-2 file:font-semibold file:text-slate-950";

export default function DashboardPage() {
  const [context, setContext] = useState<Context | null>(null);
  const [modelId, setModelId] = useState("");
  const [ifcFile, setIfcFile] = useState<File | null>(null);
  const [idsMode, setIdsMode] = useState<"" | "active" | "uploaded">("");
  const [idsFile, setIdsFile] = useState<File | null>(null);
  const [shapesMode, setShapesMode] = useState<"governed" | "temporary">("governed");
  const [shapesFile, setShapesFile] = useState<File | null>(null);
  const [shapes, setShapes] = useState<Shapes | null>(null);
  const [shacl, setShacl] = useState<ShaclReport | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void loadContext(); }, []);
  const selected = useMemo(() => context?.models.find((item) => String(item.model_id) === modelId) ?? null, [context, modelId]);
  const activeModels = context?.models.filter((model) => model.state === "active") ?? [];
  const inactiveModels = context?.models.filter((model) => model.state !== "active") ?? [];
  function modelLabel(model: Context["models"][number]) {
    return `${model.model_name} — linha ${model.model_id}`;
  }
  function chooseModel(value: string) {
    setModelId(value); setIntakeOpen(false); setIfcFile(null); setIdsFile(null); setIdsMode(""); setShapesMode("governed"); setShapesFile(null); setShapes(null); setError(null); inputsChanged();
  }

  async function loadContext() {
    try {
      const response = await fetch("/api/model-intake/context", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Model intake is not prepared.");
      setContext(payload.data);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Model intake is unavailable."); }
  }

  function formData(includeRun = false) {
    if (!ifcFile || !modelId) throw new Error("Select a logical model line and an IFC file.");
    if (!idsMode) throw new Error("Selecione um perfil IDS governado ou um ficheiro IDS temporário.");
    if (idsMode === "uploaded" && !idsFile) throw new Error("Selecione um ficheiro IDS temporário.");
    const form = new FormData();
    form.set("ifcFile", ifcFile);
    form.set("modelId", modelId);
    form.set("idsMode", idsMode as "active" | "uploaded");
    if (idsFile && idsMode === "uploaded") form.set("idsFile", idsFile);
    if (includeRun && run) form.set("preflightRunUuid", run.runUuid);
    return form;
  }

  async function validateAndPreview() {
    setBusy(true); setError(null); setRun(null); setCreated(null);
    try {
      const response = await fetch("/api/model-intake/preflight", { method: "POST", body: formData() });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Preflight failed.");
      setRun(payload.data);
      setShacl(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Preflight failed."); }
    finally { setBusy(false); }
  }

  async function createVersion() {
    if (!run) return;
    setBusy(true); setError(null); setCreated(null);
    try {
      const response = await fetch(`/api/model-intake/models/${modelId}/versions`, { method: "POST", body: formData(true) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Version creation failed.");
      setCreated(payload.data); await loadContext();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Version creation failed."); }
    finally { setBusy(false); }
  }

  function shapesForm(includeRun = false) {
    if (shapesMode === "temporary" && !shapesFile) throw new Error("Select a temporary Turtle shapes file.");
    const form = new FormData();
    form.set("shapesMode", shapesMode);
    if (shapesMode === "temporary" && shapesFile) form.set("shapesFile", shapesFile);
    if (includeRun && run) form.set("preflightRunUuid", run.runUuid);
    return form;
  }

  async function inspectShapes() {
    setBusy(true); setError(null); setShapes(null); setShacl(null);
    try {
      const response = await fetch("/api/model-intake/shacl/inspect", { method: "POST", body: shapesForm() });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "Shapes inspection failed.");
      setShapes(payload.data);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Shapes inspection failed."); }
    finally { setBusy(false); }
  }

  async function validateShacl() {
    if (!run) return;
    setBusy(true); setError(null); setShacl(null);
    try {
      const response = await fetch("/api/model-intake/shacl/validate", { method: "POST", body: shapesForm(true) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.message ?? "SHACL validation failed.");
      setShapes(payload.data.shapes); setShacl(payload.data.report);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "SHACL validation failed."); }
    finally { setBusy(false); }
  }

  function inputsChanged() { setRun(null); setCreated(null); setShacl(null); }
  function shapesChanged() { setShapes(null); setShacl(null); setCreated(null); }

  return (
    <main className="min-h-screen bg-slate-950 px-5 py-10 text-slate-100">
      <div className="mx-auto max-w-7xl space-y-7">
        <ManagerNavigation />
        <header><p className="text-sm font-semibold uppercase tracking-[.25em] text-cyan-300">Modelos</p>
          <h1 className="mt-2 text-4xl font-bold">Validar e criar uma versão</h1>
          <p className="mt-3 max-w-3xl text-slate-300">Escolha um modelo existente, selecione IFC e IDS, reveja os resultados e crie uma nova versão apenas quando estiver pronto.</p></header>
        {error && <div className="rounded-2xl border border-rose-700 bg-rose-950/50 p-5 text-rose-200" role="alert">{error}</div>}

        <section className={box}><Step n="1" title="Selecionar modelo" />
          <p className="mt-4 text-slate-300">Selecione um modelo para consultar versões, validações e ações disponíveis.</p>
          <p className="mt-2 text-sm text-slate-400">{activeModels.length} com versão ativa · {inactiveModels.length} sem versão ativa</p>
          <label className="mt-5 block text-sm font-semibold" htmlFor="model">Modelo</label>
          <select id="model" className={input} value={modelId} onChange={(event) => chooseModel(event.target.value)}>
            <option value="">Selecionar modelo</option>
            <optgroup label="Modelos com versão ativa">{activeModels.map((model) => <option value={model.model_id} key={model.model_id}>{modelLabel(model)}</option>)}</optgroup>
            <optgroup label="Modelos sem versão ativa">{inactiveModels.map((model) => <option value={model.model_id} key={model.model_id}>{modelLabel(model)}</option>)}</optgroup>
          </select>
          {selected && <article className="mt-5 rounded-xl border border-slate-700 bg-slate-950 p-5"><h3 className="text-xl font-bold">{modelLabel(selected)}</h3><p className="mt-1 text-sm text-slate-300">Contexto do modelo: {selected.linkedParent.name}</p><p className="mt-3">{selected.state === "active" ? `Versão atual: V${selected.current_version_number} — ativa.` : selected.state === "no_active_version" ? "Ainda não foi adicionada uma versão IFC." : `Sem versão ativa — versões históricas: ${selected.versionCount}.`}</p>{selected.state === "no_current_version" && selected.latestVersion?.status === "failed" && <><p className="mt-3 text-amber-200">A tentativa mais recente não foi ativada porque o processamento falhou.</p><details className="mt-2 text-sm text-slate-300"><summary>Ver detalhes</summary><p className="mt-1">Estado: falhou{selected.latestVersion.failureStage ? ` · etapa: ${selected.latestVersion.failureStage}` : ""}</p>{selected.latestVersion.message && <p className="mt-1">{selected.latestVersion.message}</p>}</details></>}<button type="button" className="mt-4 rounded border border-cyan-500 px-3 py-2 text-sm" onClick={() => setIntakeOpen(true)}>{selected.state === "no_active_version" ? "Adicionar primeira versão" : selected.state === "no_current_version" ? "Adicionar nova versão" : "Abrir modelo"}</button><details className="mt-3 text-sm text-slate-300"><summary>Detalhes técnicos</summary><dl className="mt-2 grid gap-3 sm:grid-cols-2"><Fact label="Hash IFC atual" value={selected.current_ifc_hash ?? "Sem ficheiro atual"} mono /><Fact label="Identificador do modelo" value={selected.model_uuid} mono /></dl></details></article>}
        </section>

        {selected && intakeOpen && <>

        <section id="model-intake" className={box}><Step n="2" title="Ficheiro IFC" />
          <label className="mt-5 block text-sm font-semibold" htmlFor="ifc">Selecionar .ifc</label>
          <input id="ifc" className={input} type="file" accept=".ifc" onChange={(e) => { setIfcFile(e.target.files?.[0] ?? null); inputsChanged(); }} />
          {run && <div className="mt-5 rounded-xl border border-emerald-800 bg-emerald-950/30 p-4"><p className="font-bold text-emerald-300">File processed by the server</p>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2"><Fact label="Filename" value={run.ifc.originalFilename} /><Fact label="Size" value={`${run.ifc.byteSize} bytes`} />
              <Fact label="IFC schema" value={run.ifc.detectedIfcSchema} /><Fact label="SHA-256" value={run.ifc.serverComputedSha256} mono /></dl></div>}
        </section>

        <section className={box}><Step n="3" title="Perfil IDS" />
          <div className="mt-5 grid gap-3 sm:grid-cols-2"><Choice active={idsMode === "active"} onClick={() => { setIdsMode("active"); inputsChanged(); }} title="Perfil governado ativo" />
            <Choice active={idsMode === "uploaded"} onClick={() => { setIdsMode("uploaded"); inputsChanged(); }} title="Upload temporary IDS" /></div>
          {idsMode === "uploaded" && <><label className="mt-5 block text-sm font-semibold" htmlFor="ids">Choose .ids</label>
            <input id="ids" className={input} type="file" accept=".ids,application/xml,text/xml" onChange={(e) => { setIdsFile(e.target.files?.[0] ?? null); inputsChanged(); }} /></>}
          {(run?.ids ?? (idsMode === "active" ? context?.activeIdsProfile : null)) && <ProfileCard profile={run?.ids ?? context!.activeIdsProfile} processed={Boolean(run)} />}
        </section>

        <section className={box}><Step n="4" title="Validação e pré-visualização" />
          <button className="mt-5 rounded-xl bg-cyan-500 px-6 py-3 font-bold text-slate-950 disabled:opacity-50" disabled={busy || !ifcFile || !modelId || !idsMode}
            onClick={validateAndPreview}>{busy ? "A processar ficheiros selecionados…" : "Validar e pré-visualizar"}</button>
          {run && <div className="mt-5 grid gap-3 sm:grid-cols-3"><Status label="Overall" value={run.validation.overallStatus} />
            <Status label="IDS" value={run.validation.idsStatus} /><Status label="Project rules" value={run.validation.projectRulesStatus} /></div>}
        </section>

        {run && <section className={box}><Step n="5" title="Resultados do modelo" />
          <h3 className="mt-6 text-lg font-bold">Concrete findings</h3><Findings findings={run.validation.findings} />
          <h3 className="mt-7 text-lg font-bold">Spaces and persistent identity candidates</h3><SpaceTable rows={run.rdfPreview.spaces} />
          <h3 className="mt-7 text-lg font-bold">Managed assets and persistent identity candidates</h3><AssetTable rows={run.rdfPreview.assets} />
          <div className="mt-7 grid gap-3 sm:grid-cols-4"><Fact label="Mapping" value={`${run.rdfPreview.mappingProfile} ${run.rdfPreview.mappingVersion}`} />
            <Fact label="Triple count" value={String(run.rdfPreview.tripleCount)} /><Fact label="Manifestations" value={String(run.rdfPreview.manifestationCount)} />
            <Fact label="Turtle SHA-256" value={run.rdfPreview.turtleSha256} mono /></div>
          <p className="mt-5 font-semibold text-emerald-300">RDF generated by backend</p>
          <pre className="mt-3 max-h-72 overflow-auto rounded-xl bg-slate-950 p-4 text-xs text-cyan-100">{run.rdfPreview.sampleTriples.join("\n")}</pre>
          <div className="mt-4 flex flex-wrap gap-3"><a className="rounded-lg border border-cyan-600 px-4 py-2" href={`/api/model-intake/runs/${run.runUuid}/turtle`}>Download Turtle</a>
            <a className="rounded-lg border border-cyan-600 px-4 py-2" href={`/api/model-intake/runs/${run.runUuid}/report`}>Download JSON report</a></div>
        </section>}

        <section className={box}><Step n="6" title="Validação estrutural SHACL" />
          <p className="mt-4 text-slate-300">SHACL validates graph structure and quality only. IDS, project rules and operational decisions remain separate layers.</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2"><Choice active={shapesMode === "governed"} onClick={() => { setShapesMode("governed"); shapesChanged(); }} title="Active governed shapes" />
            <Choice active={shapesMode === "temporary"} onClick={() => { setShapesMode("temporary"); shapesChanged(); }} title="Upload temporary shapes" /></div>
          {shapesMode === "temporary" && <><label className="mt-5 block text-sm font-semibold" htmlFor="shapes">Choose .ttl</label>
            <input id="shapes" className={input} type="file" accept=".ttl,text/turtle" onChange={(e) => { setShapesFile(e.target.files?.[0] ?? null); shapesChanged(); }} />
            <p className="mt-2 text-sm text-amber-300">Temporary shapes are not governed, are not loaded into Fuseki and cannot decide activation in required mode.</p></>}
          <button className="mt-5 rounded-xl border border-cyan-500 px-5 py-3 font-bold disabled:opacity-50" disabled={busy || (shapesMode === "temporary" && !shapesFile)} onClick={inspectShapes}>Inspect selected shapes</button>
          {shapes && <ShapesCard shapes={shapes} />}
          <button className="mt-5 rounded-xl bg-violet-500 px-6 py-3 font-bold text-slate-950 disabled:opacity-50" disabled={busy || !run || !shapes}
            onClick={validateShacl}>Execute real SHACL on RDF preview</button>
          {run && <div className="mt-5 grid gap-3 sm:grid-cols-3"><Status label="IDS" value={run.validation.idsStatus} />
            <Status label="Project rules" value={run.validation.projectRulesStatus} /><Status label="SHACL structural" value={shacl ? (shacl.conforms ? "pass" : "fail") : "not_evaluated"} /></div>}
          {shacl && <ShaclReportView report={shacl} />}
        </section>

        {run && <section className={box}><Step n="7" title="Criar versão" />
          <div className="mt-5 rounded-xl border border-amber-700 bg-amber-950/30 p-4">This action creates a new immutable model version and may make it current after all required checks and semantic materialisation succeed.</div>
          <button className="mt-5 rounded-xl bg-emerald-500 px-6 py-3 font-bold text-slate-950 disabled:opacity-50" disabled={busy || run.validation.blocking
            || Boolean(context?.shacl.mode === "required" && (!shacl?.conforms || shacl.shapesSource !== "governed_active_shapes"))} onClick={createVersion}>Create model version</button>
          {created && <div className="mt-6 rounded-xl border border-emerald-700 bg-emerald-950/30 p-5"><h3 className="text-xl font-bold text-emerald-300">Version created and verified</h3>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2"><Fact label="Model version UUID" value={created.versionUuid} mono /><Fact label="Version number" value={`v${created.versionNumber}`} />
              <Fact label="Activation status" value={created.semanticMaterialisation?.status === "completed" ? "active after semantic verification" : created.semanticMaterialisation?.status ?? "active"} />
              <Fact label="Graph URI" value={created.semanticMaterialisation?.namedGraphUri ?? "Disabled"} mono /><Fact label="Triple count" value={String(created.semanticMaterialisation?.tripleCount ?? 0)} />
              <Fact label="SHACL" value={created.semanticMaterialisation?.shaclValidation ? (created.semanticMaterialisation.shaclValidation.conforms ? "conforms" : "non-conformant") : "disabled"} />
              <Fact label="SHACL report graph" value={created.semanticMaterialisation?.shaclValidation?.reportGraphUri ?? "None"} mono />
              <Fact label="Previous / new current" value={`${created.previousCurrentVersion ?? "none"} → ${created.newCurrentVersion}`} /></dl>
            <div className="mt-4 flex gap-3"><a className="rounded-lg border border-emerald-600 px-4 py-2" href={`/api/model-intake/model-versions/${created.versionId}/semantic-turtle`}>Download version Turtle</a>
              <a className="rounded-lg border border-emerald-600 px-4 py-2" href={`/api/model-intake/model-versions/${created.versionId}/semantic-report`}>Download version report</a></div></div>}
        </section>}
        </>}
      </div>
    </main>
  );
}

function Step({ n, title }: { n: string; title: string }) { return <div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-full bg-cyan-500 font-bold text-slate-950">{n}</span><h2 className="text-2xl font-bold">{title}</h2></div>; }
function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div><dt className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</dt><dd className={`mt-1 break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</dd></div>; }
function Choice({ active, onClick, title }: { active: boolean; onClick: () => void; title: string }) { return <button type="button" onClick={onClick} className={`rounded-xl border p-4 text-left font-semibold ${active ? "border-cyan-400 bg-cyan-950/50" : "border-slate-700 bg-slate-950"}`}>{title}</button>; }
function Status({ label, value }: { label: string; value: string }) { const pass = value === "pass"; return <div className={`rounded-xl border p-4 ${pass ? "border-emerald-700" : "border-rose-700"}`}><div className="text-xs uppercase text-slate-400">{label}</div><div className={`mt-1 text-xl font-bold ${pass ? "text-emerald-300" : "text-rose-300"}`}>{value.toUpperCase()}</div></div>; }
function ProfileCard({ profile, processed }: { profile: Profile; processed: boolean }) { return <div className="mt-5 rounded-xl bg-slate-950 p-4"><p className="font-semibold">{processed ? "IDS processed by the server" : "Available governed profile"}</p><dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3"><Fact label="Source" value={profile.source} /><Fact label="Filename" value={profile.originalFilename} /><Fact label="Version" value={profile.version} /><Fact label="SHA-256" value={profile.sha256} mono /><Fact label="Executor" value={`${profile.executorName} ${profile.executorVersion}`} /><Fact label="Specifications / requirements" value={`${profile.specificationCount} / ${profile.requirements.length}`} /></dl>
  <div className="mt-5 space-y-3">{profile.requirements.map((r) => <div className="rounded-lg border border-slate-800 p-3" key={`${r.requirementId}-${r.requires}`}><div className="font-semibold">{r.requirementId} — {r.specification}</div><div className="mt-1 text-sm text-slate-300">Applies to: {r.appliesTo} · Requires: {r.requires} · Cardinality: {r.cardinality}{r.expectedPattern ? ` · Expected pattern: ${r.expectedPattern}` : ""}</div></div>)}</div></div>; }
function Findings({ findings }: { findings: Finding[] }) { return <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className="p-2">Layer</th><th className="p-2">Requirement</th><th className="p-2">Result</th><th className="p-2">Entity</th><th className="p-2">Evidence</th></tr></thead><tbody>{findings.map((f, i) => <tr className="border-t border-slate-800" key={`${f.source}-${f.requirementId}-${f.entityGuid ?? i}`}><td className="p-2">{f.source}</td><td className="p-2">{f.requirementName}</td><td className="p-2 font-bold">{f.status}</td><td className="p-2 font-mono text-xs">{f.entityType} {f.entityGuid}</td><td className="p-2">{f.message}</td></tr>)}</tbody></table></div>; }
function SpaceTable({ rows }: { rows: Space[] }) { return <Table headers={["Persistent space UUID", "Reference", "IFC GUID / class", "Storey", "Persistent URI", "Manifestation URI"]} rows={rows.map((r) => [r.persistentUuid, r.reference, `${r.ifcGuid} / ${r.ifcClass}`, r.storey ?? "—", r.persistentUri, r.manifestationUri])} />; }
function AssetTable({ rows }: { rows: Asset[] }) { return <Table headers={["Persistent asset UUID", "Tag / serial", "IFC GUID / class", "Containing space", "Persistent URI", "Manifestation URI"]} rows={rows.map((r) => [r.persistentUuid, `${r.tag} / ${r.serialNumber ?? "—"}`, `${r.ifcGuid} / ${r.ifcClass}`, r.containingSpace ?? "—", r.persistentUri, r.manifestationUri])} />; }
function Table({ headers, rows }: { headers: string[]; rows: string[][] }) { return <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[900px] text-left text-xs"><thead className="text-slate-400"><tr>{headers.map((h) => <th className="p-2" key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr className="border-t border-slate-800" key={i}>{row.map((v, j) => <td className="max-w-xs break-all p-2" key={j}>{v}</td>)}</tr>)}</tbody></table></div>; }
function short(value: string | null) { return value?.split(/[\/#]/).pop() ?? "—"; }
function ShapesCard({ shapes }: { shapes: Shapes }) { return <div className="mt-5 rounded-xl bg-slate-950 p-4"><p className="font-semibold">{shapes.source === "governed_active_shapes" ? "Governed shapes resolved by backend" : "Temporary non-governed shapes inspected by backend"}</p>
  <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3"><Fact label="Filename" value={shapes.filename} /><Fact label="Version" value={shapes.version ?? "temporary"} /><Fact label="SHA-256" value={shapes.sha256} mono /><Fact label="Source" value={shapes.source} /><Fact label="Executor" value={`${shapes.executorName} ${shapes.executorVersion}`} /><Fact label="Constraints" value={String(shapes.constraints.length)} /></dl>
  <Table headers={["Target", "Path", "Counts", "Datatype / class / node kind", "Pattern", "Severity", "Message"]} rows={shapes.constraints.map((c) => [c.targets.map((t) => `${t.kind}: ${short(t.value)}`).join(", "), short(c.path), `${c.minCount ?? "—"} / ${c.maxCount ?? "—"}`, [short(c.datatype), short(c.class), short(c.nodeKind)].filter((v) => v !== "—").join(" / ") || "—", c.pattern ?? "—", short(c.severity), c.message ?? "—"])} /></div>; }
function ShaclReportView({ report }: { report: ShaclReport }) { return <div className="mt-6 rounded-xl border border-violet-700 bg-violet-950/20 p-5"><h3 className="text-xl font-bold">Explainable SHACL report</h3>
  <dl className="mt-4 grid gap-3 sm:grid-cols-3"><Fact label="Conforms" value={String(report.conforms)} /><Fact label="Results" value={String(report.resultCount)} /><Fact label="Data SHA-256" value={report.dataGraphSha256} mono /><Fact label="Shapes SHA-256" value={report.shapesGraphSha256} mono /><Fact label="Executor" value={`${report.executorName} ${report.executorVersion}`} /><Fact label="Shapes source" value={report.shapesSource} /></dl>
  <Table headers={["Severity", "Focus node", "Path", "Value", "Message", "Source shape"]} rows={report.results.map((r) => [short(r.severity), r.focusNode ?? "—", r.resultPath ?? "—", r.value ?? "—", r.message ?? "—", r.sourceShape ?? "—"])} />
  <div className="mt-4 flex flex-wrap gap-3"><a className="rounded-lg border border-violet-500 px-4 py-2" href={`/api/semantic-validation/runs/${report.runUuid}/report`}>Download report JSON</a><a className="rounded-lg border border-violet-500 px-4 py-2" href={`/api/semantic-validation/runs/${report.runUuid}/report.ttl`}>Download report Turtle</a><a className="rounded-lg border border-violet-500 px-4 py-2" href={`/api/semantic-validation/runs/${report.runUuid}/data.ttl`}>Download validated data Turtle</a></div></div>; }
