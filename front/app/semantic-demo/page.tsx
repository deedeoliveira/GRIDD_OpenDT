"use client";

import { useEffect, useState } from "react";
import type { ApiEnvelope, DemoActor, InstitutionalContext } from "./institutionalDemoTypes";

const SCENARIO_LABELS: Record<DemoActor["scenario"], string> = {
  complete_context: "Scenario A — complete context",
  no_supervisor_assertion: "Scenario B — no supervisor assertion",
  revoked_link: "Scenario C — revoked link",
};

function shortType(uri: string): string {
  return uri.split(/[\/#]/).filter(Boolean).at(-1) ?? uri;
}

export default function SemanticDemoPage() {
  const [actors, setActors] = useState<DemoActor[]>([]);
  const [selected, setSelected] = useState("");
  const [context, setContext] = useState<InstitutionalContext | null>(null);
  const [state, setState] = useState<"loading" | "success" | "disabled" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/institutional/demo/actors", { cache: "no-store" });
        const payload = await response.json() as ApiEnvelope<DemoActor[]>;
        if (!response.ok || !payload.data?.length) {
          setState("disabled");
          setMessage("The institutional demonstrator is disabled or has not been prepared by the technical executor.");
          return;
        }
        setActors(payload.data);
        setSelected(payload.data[0]!.actorKey);
      } catch {
        setState("error");
        setMessage("The institutional demonstrator could not be reached.");
      }
    })();
  }, []);

  useEffect(() => {
    if (!selected) return;
    void (async () => {
      setState("loading");
      setContext(null);
      try {
        const response = await fetch(`/api/institutional/actors/${encodeURIComponent(selected)}/context`, { cache: "no-store" });
        const payload = await response.json() as ApiEnvelope<InstitutionalContext>;
        if (!response.ok || !payload.data) {
          setState(response.status === 503 || response.status === 404 ? "disabled" : "error");
          setMessage(payload.message ?? "Institutional context is unavailable.");
          return;
        }
        setContext(payload.data);
        setState("success");
      } catch {
        setState("error");
        setMessage("Institutional context is unavailable.");
      }
    })();
  }, [selected]);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <header className="mb-9 border-b border-slate-800 pb-8">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300">OSWADT · Research evidence</p>
          <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">Institutional semantic context</h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-slate-300">
            Follow a synthetic platform actor to verified institutional graph evidence and its governed artifact provenance.
          </p>
        </header>

        <aside className="mb-8 rounded-2xl border border-amber-400/40 bg-amber-400/10 p-5 text-sm leading-6 text-amber-100" role="note">
          <strong>Synthetic research demonstrator.</strong> The actor key is not authenticated. The displayed graph evidence does not authorize or approve a reservation.
        </aside>

        <section className="mb-8 rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <label htmlFor="actor" className="mb-2 block text-sm font-medium text-slate-300">Synthetic actor scenario</label>
          <select
            id="actor"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            disabled={actors.length === 0}
            className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none focus:border-cyan-400 md:max-w-xl"
          >
            {actors.map((actor) => <option key={actor.actorKey} value={actor.actorKey}>{SCENARIO_LABELS[actor.scenario]} · {actor.actorKey}</option>)}
          </select>
        </section>

        {state === "loading" && <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 text-slate-300" aria-live="polite">Loading governed institutional evidence…</div>}
        {(state === "disabled" || state === "error") && <div className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-6 text-rose-100" role="status">{message}</div>}

        {state === "success" && context && !context.contextAvailable && (
          <section className="rounded-2xl border border-rose-400/30 bg-rose-400/10 p-7">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-rose-200">Link found · evidence not used</p>
            <h2 className="mt-3 text-2xl font-semibold">Current institutional context is unavailable</h2>
            <p className="mt-3 text-rose-100">Reason: <strong>{context.unavailableReason}</strong>. Link status: <strong>{context.link.status}</strong>.</p>
            <p className="mt-3 text-sm text-rose-100/80">No graph evidence was used for this revoked or otherwise unavailable link.</p>
          </section>
        )}

        {state === "success" && context?.contextAvailable && context.person && (
          <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-6">
              <section className="rounded-2xl border border-cyan-400/20 bg-slate-900 p-7">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Verified institutional person</p>
                <h2 className="mt-3 text-3xl font-semibold">{context.person.label}</h2>
                <p className="mt-3 font-mono text-cyan-100">{context.person.studentNumber ?? "No student number asserted"}</p>
                <div className="mt-5 flex flex-wrap gap-2">{context.person.types.map((type) => <span key={type} className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300">{shortType(type)}</span>)}</div>
              </section>

              <section className="rounded-2xl border border-slate-800 bg-slate-900 p-7">
                <h2 className="text-xl font-semibold">Memberships and roles</h2>
                <div className="mt-5 space-y-4">{context.memberships.map((membership) => (
                  <article key={membership.membershipUri} className="rounded-xl bg-slate-950/70 p-5">
                    <h3 className="font-medium text-cyan-100">{membership.organization.label}</h3>
                    <ul className="mt-3 space-y-1 text-sm text-slate-300">{membership.roles.map((role) => <li key={role.uri}>• {role.label}</li>)}</ul>
                  </article>
                ))}</div>
              </section>

              <section className="rounded-2xl border border-slate-800 bg-slate-900 p-7">
                <h2 className="text-xl font-semibold">Supervisor evidence</h2>
                {context.supervisors.length > 0
                  ? <ul className="mt-4 space-y-2">{context.supervisors.map((supervisor) => <li key={supervisor.uri} className="rounded-xl bg-slate-950/70 p-4 text-cyan-100">{supervisor.label}</li>)}</ul>
                  : <p className="mt-4 rounded-xl bg-slate-950/70 p-4 text-slate-300">No supervisor assertion is present in the active synthetic graph.</p>}
              </section>
            </div>

            <aside className="space-y-6">
              <section className="rounded-2xl border border-slate-800 bg-slate-900 p-7">
                <h2 className="text-xl font-semibold">Governed provenance</h2>
                <dl className="mt-5 space-y-4 text-sm">
                  <div><dt className="text-slate-400">Dataset version</dt><dd className="mt-1 font-mono">{context.artifactContext?.datasetVersion}</dd></div>
                  <div><dt className="text-slate-400">Ontology version</dt><dd className="mt-1 font-mono">{context.artifactContext?.ontologyVersion}</dd></div>
                  <div><dt className="text-slate-400">Bridge version</dt><dd className="mt-1 font-mono">{context.artifactContext?.bridgeVersion}</dd></div>
                  <div><dt className="text-slate-400">Link status</dt><dd className="mt-1">{context.link.status}</dd></div>
                </dl>
              </section>
              <section className="rounded-2xl border border-slate-800 bg-slate-900 p-7">
                <h2 className="text-xl font-semibold">Interpretation limits</h2>
                <ul className="mt-4 space-y-2 text-sm text-slate-300">{context.caveats.map((caveat) => <li key={caveat}>• {caveat.replaceAll("_", " ")}</li>)}</ul>
              </section>
            </aside>
          </div>
        )}
      </div>
    </main>
  );
}
