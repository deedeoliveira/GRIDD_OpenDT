"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, CircularProgress } from "@heroui/react";
import { Viewer } from "./Viewer";
import ReservationModal from "./ReservationModal";
import type { StudentModelContext } from "@/types/model";
import { formatLisbonDateTime, lisbonTimeZoneLabel } from "@/lib/lisbonDateTime";

type StudentMode = "model" | "catalogue" | "manage" | null;
type LoadState = "not_selected" | "selected" | "loading" | "loaded" | "no_current" | "failed" | "unavailable" | "unauthorized" | "error";
type SelectedIfcInfo = { guid: string; name?: string; ifcClass?: string; predefinedType?: string; tag?: string };
type StudentAsset = {
  persistentAssetId: string;
  name: string;
  tag: string | null;
  location: { name: string | null; reference: string | null };
  representation: { kind: "modelled" | "non_modelled" | "undetermined"; modelLineId?: number; modelName?: string; linkedModelId?: number };
};
type ModelReservationContext = { modelLineName: string; modelLineId: number; currentVersionId: number | null; currentVersionNumber: number | null };
type ReservationRow = { id: number; asset_id: number; name?: string; asset_code?: string | null; start_time: string; end_time: string; status: string; decision?: { type: "approve" | "reject" | "cancel"; status: string; reason: string | null; decidedAt: string | null; decidedByRole: string | null } | null };

const modes: Array<{ key: Exclude<StudentMode, null>; title: string; description: string }> = [
  { key: "model", title: "Reservar através do modelo", description: "Selecione um modelo, explore os seus elementos e reserve um equipamento modelado." },
  { key: "catalogue", title: "Reservar sem modelo", description: "Consulte todos os ativos reserváveis através de uma lista pesquisável." },
  { key: "manage", title: "Gerir reservas", description: "Acompanhe pedidos existentes e execute as ações disponíveis." },
];

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

export default function StudentPage() {
  const [mode, setMode] = useState<StudentMode>(null);
  const [modelContexts, setModelContexts] = useState<StudentModelContext[]>([]);
  const [selectedModelLineId, setSelectedModelLineId] = useState("");
  const [viewerContext, setViewerContext] = useState<StudentModelContext | null>(null);
  const [viewerKey, setViewerKey] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>("not_selected");
  const [loadMessage, setLoadMessage] = useState("");
  const [treeRootCount, setTreeRootCount] = useState(0);
  const [selectedIfc, setSelectedIfc] = useState<SelectedIfcInfo | null>(null);
  const [assets, setAssets] = useState<StudentAsset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetsMessage, setAssetsMessage] = useState("");
  const [search, setSearch] = useState("");
  const [selectedAsset, setSelectedAsset] = useState<StudentAsset | null>(null);
  const [actorId, setActorId] = useState("");
  const [reservations, setReservations] = useState<ReservationRow[]>([]);
  const [reservationOpen, setReservationOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedContext = useMemo(
    () => modelContexts.find((item) => String(item.modelLineId) === selectedModelLineId) ?? null,
    [modelContexts, selectedModelLineId],
  );
  const activeContexts = modelContexts.filter((item) => item.currentVersionId !== null);
  const inactiveContexts = modelContexts.filter((item) => item.currentVersionId === null);

  async function fetchReservations() {
    const { response, payload } = await fetchJson("/api/reservations/mine", { cache: "no-store" });
    return response.ok ? (payload?.data ?? payload ?? []) as ReservationRow[] : [];
  }

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("mode");
    if (requested === "model" || requested === "catalogue" || requested === "manage") setMode(requested);
    let cancelled = false;
    void fetchJson("/api/auth/session", { cache: "no-store" }).then(({ response, payload }) => {
      const session = payload?.data;
      if (cancelled) return;
      if (response.ok && session?.applicationArea === "manager") return window.location.assign("/dashboard");
      if (response.ok && typeof session?.accountKey === "string") setActorId(session.accountKey);
      if (response.status === 401) window.location.assign("/login");
    });
    void fetchJson("/api/model/student-contexts", { cache: "no-store" }).then(({ response, payload }) => {
      if (!cancelled && response.ok) setModelContexts(payload?.data ?? []);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { if (actorId) void fetchReservations().then(setReservations); }, [actorId]);

  useEffect(() => {
    if (mode !== "catalogue") return;
    let cancelled = false;
    setAssetsLoading(true); setAssetsMessage(""); setAssets([]); setSelectedAsset(null); setReservationOpen(false);
    void fetchJson("/api/asset/persistent/reservable", { cache: "no-store" }).then(({ response, payload }) => {
      if (cancelled) return;
      if (!response.ok) setAssetsMessage(response.status === 401 || response.status === 403 ? "A sessão atual não está autorizada a consultar este catálogo." : "Não foi possível consultar os ativos reserváveis.");
      else setAssets(payload?.data?.items ?? []);
    }).finally(() => { if (!cancelled) setAssetsLoading(false); });
    return () => { cancelled = true; };
  }, [mode]);

  function chooseMode(next: Exclude<StudentMode, null>) {
    setMode(next); setViewerContext(null); setSelectedModelLineId(""); setSelectedIfc(null); setTreeRootCount(0);
    setLoadState("not_selected"); setLoadMessage(""); setSelectedAsset(null); setReservationOpen(false); setNotice(null);
    const url = new URL(window.location.href); url.searchParams.set("mode", next); window.history.replaceState({}, "", url);
  }

  function chooseModelLine(value: string) {
    setSelectedModelLineId(value); setViewerContext(null); setSelectedIfc(null); setSelectedAsset(null); setReservationOpen(false);
    setTreeRootCount(0); setLoadMessage("");
    const next = modelContexts.find((item) => String(item.modelLineId) === value) ?? null;
    if (!next) setLoadState("not_selected");
    else if (next.currentVersionId === null) setLoadState(next.latestVersion?.status === "failed" ? "failed" : "no_current");
    else setLoadState("selected");
  }

  function openSelectedModel() {
    if (!selectedContext?.currentVersionId) return;
    setSelectedIfc(null); setSelectedAsset(null); setReservationOpen(false); setTreeRootCount(0); setLoadMessage("");
    setLoadState("loading"); setViewerKey((value) => value + 1); setViewerContext(selectedContext);
  }

  async function resolveIfcAsset(info: SelectedIfcInfo) {
    setSelectedIfc(info); setSelectedAsset(null); setReservationOpen(false); setAssetsMessage("");
    if (!info.guid || !viewerContext) return;
    const { response, payload } = await fetchJson(`/api/asset/persistent/current-binding/${viewerContext.modelLineId}/${encodeURIComponent(info.guid)}`, { cache: "no-store" });
    if (response.ok) setSelectedAsset(payload?.data ?? null);
    else if (response.status === 404) setAssetsMessage(isNonEquipmentClass(info.ifcClass)
      ? "O elemento selecionado não representa um equipamento reservável."
      : "Este elemento IFC não possui um binding corrente para um ativo persistente reservável.");
    else setAssetsMessage("Não foi possível resolver o ativo persistente deste elemento.");
  }

  function handleViewerState(state: "loading" | "loaded" | "error", message?: string) {
    if (state === "error") {
      const normalized = message ?? "Falha técnica ao carregar o modelo.";
      setLoadState(normalized.includes("autorizada") ? "unauthorized" : normalized.includes("disponível") ? "unavailable" : "error");
      setLoadMessage(normalized);
    } else setLoadState(state);
  }

  async function reservationAction(path: "checkin" | "checkout" | "cancel", reservationId: number) {
    if (path === "cancel" && !window.confirm("Cancelar este pedido de reserva?")) return;
    const { response, payload } = await fetchJson(`/api/reservation/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reservationId }) });
    if (!response.ok) { setNotice(payload?.error ?? payload?.message ?? "A ação não foi permitida pelo estado atual."); return; }
    setNotice(payload?.data?.message ?? payload?.message ?? "Ação concluída.");
    setReservations(await fetchReservations());
  }

  async function logout() { await fetch("/api/auth/logout", { method: "POST" }); window.location.assign("/login"); }

  if (!mode) return <main className="uminho-page p-6"><div className="mx-auto max-w-6xl"><StudentHeader logout={logout} /><div className="grid gap-5 md:grid-cols-3">{modes.map((item) => <button className="uminho-mode-card" key={item.key} onClick={() => chooseMode(item.key)}><h2 className="text-xl font-semibold">{item.title}</h2><p className="mt-2" style={{ color: "var(--text-secondary)" }}>{item.description}</p></button>)}</div></div></main>;

  return <main className="uminho-page min-h-screen">
    <StudentWorkspaceHeader mode={mode} chooseMode={chooseMode} logout={logout} />
    {mode === "model" && <section role="tabpanel" aria-label="Reservar através do modelo" className="relative min-h-[calc(100vh-5rem)]">
      <div className="relative z-20 mx-auto grid max-w-7xl gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(19rem,25rem)]">
        <div className="uminho-card p-4">
          <label className="block text-sm font-semibold">Logical model line
            <select className="uminho-input mt-2 w-full p-2" value={selectedModelLineId} onChange={(event) => chooseModelLine(event.target.value)}>
              <option value="">Selecionar modelo</option>
              <optgroup label="Com versão ativa">{activeContexts.map((context) => <option key={context.modelLineId} value={context.modelLineId}>{context.modelLineName} — linha {context.modelLineId} · {context.linkedModelName}</option>)}</optgroup>
              <optgroup label="Sem versão ativa">{inactiveContexts.map((context) => <option key={context.modelLineId} value={context.modelLineId}>{context.modelLineName} — linha {context.modelLineId} · {context.linkedModelName}</option>)}</optgroup>
            </select>
          </label>
          {selectedContext?.currentVersionId && <div className="mt-3 flex items-center justify-between gap-3"><p className="text-sm">Versão corrente: {selectedContext.currentVersionNumber} · estado {selectedContext.currentVersionStatus}</p><button className="uminho-primary-button px-4 py-2" onClick={openSelectedModel}>Carregar modelo</button></div>}
          {loadState === "no_current" && <p className="mt-3 text-sm text-amber-800">Sem versão ativa. É necessário adicionar uma nova versão no workspace de gestão.</p>}
          {loadState === "failed" && <div className="mt-3 text-sm text-amber-800"><p>Sem versão ativa. A tentativa mais recente não foi ativada porque o processamento falhou.</p>{selectedContext?.latestVersion && <details className="mt-2"><summary>Detalhes da tentativa</summary><p>Estado: {selectedContext.latestVersion.status}{selectedContext.latestVersion.failureStage ? ` · etapa: ${selectedContext.latestVersion.failureStage}` : ""}</p>{selectedContext.latestVersion.message && <p>{selectedContext.latestVersion.message}</p>}</details>}</div>}
          {loadState === "loading" && <div className="mt-3 flex items-center gap-2 text-sm"><CircularProgress size="sm" aria-label="A carregar modelo" />A carregar IFC, visualizador e árvore…</div>}
          {loadState === "loaded" && <p className="mt-3 text-sm text-green-800">Modelo carregado. Árvore IFC: {treeRootCount ? "disponível" : "a preparar"}.</p>}
          {["unavailable", "unauthorized", "error"].includes(loadState) && <p className="mt-3 text-sm text-red-800" role="alert">{loadMessage}</p>}
        </div>
        <SelectedResourcePanel
          viewerReady={Boolean(viewerContext && loadState === "loaded")}
          selectedIfc={selectedIfc}
          asset={selectedAsset}
          message={assetsMessage}
          actorId={actorId}
          open={reservationOpen}
          setOpen={setReservationOpen}
          modelContext={viewerContext ? { modelLineName: viewerContext.modelLineName, modelLineId: viewerContext.modelLineId, currentVersionId: viewerContext.currentVersionId, currentVersionNumber: viewerContext.currentVersionNumber } : null}
          afterReservation={() => void fetchReservations().then(setReservations)}
        />
      </div>
      {viewerContext && <Viewer key={viewerKey} selectedModel={viewerContext} onWorldInitialized={() => setLoadState("loaded")} onLoadStateChange={handleViewerState} onTreeStateChange={setTreeRootCount} onElementSelected={(info) => { if (info.guid) void resolveIfcAsset(info); }} />}
    </section>}

    {mode === "catalogue" && <section role="tabpanel" aria-label="Reservar sem modelo" className="mx-auto max-w-7xl space-y-5 p-6">
      <header><h2 className="text-2xl font-semibold">Reservar sem modelo</h2><p className="mt-1" style={{ color: "var(--text-secondary)" }}>A mesma identidade persistente e o mesmo motor de reserva, sem carregar IFC.</p></header>
      <label className="block max-w-2xl text-sm font-semibold">Pesquisar ativos<input className="uminho-input mt-2 w-full p-3" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Pesquisar por nome, Tag/Reference ou localização" /></label>
      {assetsLoading ? <div className="flex items-center gap-2"><CircularProgress size="sm" />A consultar ativos…</div> : assetsMessage ? <p role="alert">{assetsMessage}</p> : <AssetCatalogue assets={assets} search={search} selected={selectedAsset} select={(asset) => { setSelectedAsset(asset); setReservationOpen(true); }} />}
      {selectedAsset && reservationOpen && <ReservationModal presentation="dialog" asset={selectedAsset} actorId={actorId} onClose={() => { setReservationOpen(false); void fetchReservations().then(setReservations); }} />}
    </section>}

    {mode === "manage" && <section role="tabpanel" aria-label="Gerir reservas" className="mx-auto max-w-7xl space-y-5 p-6">
      <header><h2 className="text-2xl font-semibold">Gerir reservas</h2><p className="mt-1" style={{ color: "var(--text-secondary)" }}>Pedidos e histórico da conta atual. A criação de novos pedidos pertence aos outros dois workspaces.</p></header>
      {notice && <p className="uminho-card p-3" role="status">{notice}</p>}
      {reservations.length === 0 ? <p>Não existem reservas.</p> : <ReservationGroups reservations={reservations} action={reservationAction} />}
    </section>}
  </main>;
}

function StudentHeader({ logout }: { logout: () => void }) { return <header className="mb-8 flex items-start justify-between gap-4"><div><p className="text-sm font-semibold uppercase tracking-[.16em]" style={{ color: "var(--uminho-primary)" }}>Universidade do Minho</p><h1 className="mt-2 text-3xl font-semibold">Área do estudante</h1><p className="mt-2" style={{ color: "var(--text-secondary)" }}>Escolha o espaço de trabalho para esta sessão.</p></div><button className="uminho-secondary-button px-3 py-2" onClick={logout}>Terminar sessão</button></header>; }

function StudentWorkspaceHeader({ mode, chooseMode, logout }: { mode: Exclude<StudentMode, null>; chooseMode: (mode: Exclude<StudentMode, null>) => void; logout: () => void }) { return <header className="relative z-30 flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}><div><p className="text-xs font-semibold uppercase tracking-[.16em]" style={{ color: "var(--uminho-primary)" }}>Universidade do Minho</p><h1 className="text-xl font-semibold">Área do estudante</h1></div><div className="flex flex-wrap items-center gap-2"><nav className="flex flex-wrap rounded-lg border p-1" style={{ borderColor: "var(--border)" }} aria-label="Espaço de trabalho">{modes.map((item) => <button key={item.key} role="tab" aria-selected={mode === item.key} className={`rounded px-3 py-2 text-sm ${mode === item.key ? "text-white" : ""}`} style={mode === item.key ? { background: "var(--uminho-primary)" } : undefined} onClick={() => chooseMode(item.key)}>{item.title}</button>)}</nav><button className="uminho-secondary-button px-3 py-2 text-sm" onClick={logout}>Terminar sessão</button></div></header>; }

function AssetCatalogue({ assets, search, selected, select }: { assets: StudentAsset[]; search: string; selected: StudentAsset | null; select: (asset: StudentAsset) => void }) {
  const term = search.trim().toLocaleLowerCase("pt");
  const filtered = assets.filter((asset) => !term || [asset.name, asset.tag, asset.location.name, asset.location.reference].some((value) => value?.toLocaleLowerCase("pt").includes(term)));
  if (!filtered.length) return <p>Nenhum ativo corresponde à pesquisa.</p>;
  const groups: Array<{ kind: StudentAsset["representation"]["kind"]; title: string }> = [{ kind: "modelled", title: "Ativos modelados" }, { kind: "non_modelled", title: "Ativos não modelados" }, { kind: "undetermined", title: "Origem não determinada" }];
  return <div className="space-y-6">{groups.map((group) => { const items = filtered.filter((asset) => asset.representation.kind === group.kind); if (!items.length && group.kind === "undetermined") return null; return <section key={group.kind}><h3 className="mb-3 text-lg font-semibold">{group.title}</h3>{items.length === 0 ? <p className="uminho-card p-4 text-sm">Nenhum ativo disponível neste grupo.</p> : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{items.map((asset) => <article className={`uminho-card p-4 ${selected?.persistentAssetId === asset.persistentAssetId ? "ring-2 ring-[var(--uminho-primary)]" : ""}`} key={asset.persistentAssetId}><h4 className="font-semibold">{asset.name}</h4><p className="mt-1 text-sm">Tag/Reference: {asset.tag ?? "Não registada"}</p><p className="text-sm">Localização: {asset.location.name ?? "Localização não registada"}{asset.location.reference ? ` (${asset.location.reference})` : ""}</p>{asset.representation.kind === "modelled" && <p className="text-sm">Modelo: {asset.representation.modelName}</p>}<button className="uminho-primary-button mt-3 px-3 py-2 text-sm" onClick={() => select(asset)}>Selecionar ativo</button></article>)}</div>}</section>; })}</div>;
}

function SelectedResourcePanel({ viewerReady, selectedIfc, asset, message, actorId, open, setOpen, modelContext, afterReservation }: { viewerReady: boolean; selectedIfc: SelectedIfcInfo | null; asset: StudentAsset | null; message: string; actorId: string; open: boolean; setOpen: (value: boolean) => void; modelContext: ModelReservationContext | null; afterReservation: () => void }) {
  return <aside className="uminho-card self-start p-4" data-testid="selected-resource-panel" aria-label="Recurso selecionado"><h2 className="font-semibold">Recurso selecionado</h2>{!viewerReady ? <p className="mt-2 text-sm">Carregue um modelo e selecione um elemento para iniciar um pedido.</p> : !selectedIfc ? <p className="mt-2 text-sm">Selecione um elemento no modelo ou na árvore IFC.</p> : asset ? <AssetSelection asset={asset} actorId={actorId} open={open} setOpen={setOpen} modelContext={modelContext} afterReservation={afterReservation} /> : <p className="mt-2 text-sm" role="status">{message || "A resolver o binding corrente do elemento selecionado…"}</p>}</aside>;
}

function AssetSelection({ asset, actorId, open, setOpen, modelContext, afterReservation }: { asset: StudentAsset; actorId: string; open: boolean; setOpen: (value: boolean) => void; modelContext: ModelReservationContext | null; afterReservation: () => void }) {
  const startRequestRef = useRef<HTMLButtonElement>(null);
  const closeDialog = () => { startRequestRef.current?.focus(); setOpen(false); afterReservation(); };
  return <div className="mt-2"><p><strong>{asset.name}</strong> · {asset.tag ?? "Sem referência"}</p><p className="text-sm">Localização: {asset.location.name ?? "Localização não registada"}</p><button ref={startRequestRef} type="button" className="uminho-primary-button mt-3 px-4 py-2" data-testid="model-start-reservation" disabled={!actorId} onClick={() => setOpen(true)}>Iniciar pedido</button>{open && <ReservationModal presentation="dialog" asset={asset} actorId={actorId} sourceContext={modelContext} onClose={closeDialog} />}</div>;
}

function ReservationGroups({ reservations, action }: { reservations: ReservationRow[]; action: (path: "checkin" | "checkout" | "cancel", id: number) => void }) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const groups = [{ key: "pending", statuses: ["pending"], title: "Pendentes" }, { key: "approved", statuses: ["approved"], title: "Aprovadas" }, { key: "in_use", statuses: ["in_use", "overdue"], title: "Em utilização" }, { key: "completed", statuses: ["completed"], title: "Concluídas" }, { key: "rejected", statuses: ["rejected"], title: "Rejeitadas" }, { key: "cancelled", statuses: ["cancelled", "no_show"], title: "Canceladas" }];
  return <div className="space-y-3">{groups.map((group) => { const rows = reservations.filter((row) => group.statuses.includes(row.status)); const open = openGroup === group.key; return <section className="uminho-card overflow-hidden" key={group.key}><h3><button type="button" className="flex w-full items-center justify-between gap-4 p-5 text-left text-lg font-semibold hover:bg-[var(--uminho-primary-light)]" aria-expanded={open} aria-controls={`reservation-group-${group.key}`} onClick={() => setOpenGroup(open ? null : group.key)}><span>{group.title}</span><span className="rounded-full bg-[var(--uminho-primary-light)] px-3 py-1 text-sm text-[var(--uminho-primary-dark)]" aria-label={`${rows.length} reservas`}>{rows.length}</span></button></h3>{open && <div id={`reservation-group-${group.key}`} className="divide-y border-t border-[var(--border)] px-5">{rows.length === 0 ? <p className="py-4 text-sm">Não existem reservas neste grupo.</p> : rows.map((row) => <article className="py-4" key={row.id}><div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="font-semibold">{row.name ?? `Recurso ${row.asset_code ?? ""}`}</h4><p className="text-sm">{formatLisbonDateTime(row.start_time)} → {formatLisbonDateTime(row.end_time)}</p><p className="text-sm">Estado: {row.status}</p><DecisionDetails reservation={row} /></div><div className="flex gap-2">{["pending", "approved"].includes(row.status) && <Button size="sm" variant="bordered" onPress={() => action("cancel", row.id)}>Cancelar pedido</Button>}{row.status === "approved" && <Button size="sm" color="primary" onPress={() => action("checkin", row.id)}>Check-in</Button>}{["in_use", "overdue"].includes(row.status) && <Button size="sm" color="danger" onPress={() => action("checkout", row.id)}>Checkout</Button>}</div></div><details className="mt-2 text-sm"><summary>Detalhes técnicos</summary><p>Reserva #{row.id} · recurso operacional #{row.asset_id}</p></details></article>)}</div>}</section>; })}</div>;
}

function isNonEquipmentClass(ifcClass?: string) { return Boolean(ifcClass && /^(IFCSPACE|IFCBUILDING|IFCBUILDINGSTOREY|IFCSITE|IFCWALL|IFCSLAB|IFCDOOR|IFCWINDOW|IFCROOF|IFCSTAIR)/i.test(ifcClass)); }

function DecisionDetails({ reservation }: { reservation: ReservationRow }) { const decision = reservation.decision; if (!decision) return reservation.status === "cancelled" || reservation.status === "rejected" ? <p className="text-sm">No reason was recorded for this historical decision.</p> : null; return <div className="mt-1 text-sm">{decision.reason ? <p>Razão: {decision.reason}</p> : (reservation.status === "cancelled" || reservation.status === "rejected") && <p>No reason was recorded for this historical decision.</p>}{decision.decidedAt && <p>Data da decisão: {formatLisbonDateTime(decision.decidedAt)} ({lisbonTimeZoneLabel})</p>}{decision.decidedByRole && <p>Origem da decisão: {decision.decidedByRole.replaceAll("_", " ")}</p>}</div>; }
