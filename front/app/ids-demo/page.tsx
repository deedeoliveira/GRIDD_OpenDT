"use client";

import { useState } from "react";

type Finding = {
  source: "ids" | "project_rule";
  requirementId: string;
  requirementName: string;
  status: "pass" | "fail" | "warning" | "not_evaluated";
  message: string;
  entityType: string | null;
  entityGuid: string | null;
};

type DemoResult = {
  scenario: string;
  title: string;
  explanation: string;
  report: {
    overallStatus: "pass" | "fail" | "error";
    idsStatus: string;
    projectRulesStatus: string;
    profile: { version: string; sha256: string; familyKey: string } | null;
    executor: { name: string; version: string } | null;
    findings: Finding[];
  };
};

const scenarios = [
  ["invalid-missing-reference", "Scenario A — Missing Reference"],
  ["valid", "Scenario B — Valid model"],
  ["duplicate-reference", "Scenario C — Duplicate Reference"],
] as const;

function Status({ label, value }: { label: string; value: string }) {
  const positive = value === "pass";
  return (
    <div className={`rounded-xl border p-4 ${positive ? "border-emerald-700 bg-emerald-950/40" : "border-rose-700 bg-rose-950/40"}`}>
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${positive ? "text-emerald-300" : "text-rose-300"}`}>{value.toUpperCase()}</div>
    </div>
  );
}

export default function IdsDemoPage() {
  const [scenario, setScenario] = useState<string>(scenarios[0][0]);
  const [result, setResult] = useState<DemoResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setMessage(null);
    setResult(null);
    try {
      const response = await fetch(`/api/model-requirements/demo/${encodeURIComponent(scenario)}`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.message || "Validation could not be completed.");
      setResult(payload.data);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Validation could not be completed.");
    } finally {
      setLoading(false);
    }
  }

  const idsFindings = result?.report.findings.filter((finding) => finding.source === "ids") ?? [];
  const projectFindings = result?.report.findings.filter((finding) => finding.source === "project_rule") ?? [];

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-12 text-slate-100">
      <div className="mx-auto max-w-5xl">
        <p className="text-sm font-semibold uppercase tracking-[0.25em] text-cyan-300">IFC information requirements</p>
        <h1 className="mt-3 text-4xl font-bold">IDS functional validation demonstrator</h1>
        <p className="mt-4 max-w-3xl text-slate-300">Compare a genuine IDS completeness check with a project-specific cross-instance identity rule.</p>

        <div className="mt-8 rounded-2xl border border-amber-700 bg-amber-950/40 p-5 text-amber-100" role="note">
          This demonstrator validates IFC information requirements. It does not determine reservability, eligibility, authorization or approval.
        </div>

        <section className="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <label className="block text-sm font-semibold" htmlFor="scenario">Synthetic scenario</label>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row">
            <select id="scenario" value={scenario} onChange={(event) => setScenario(event.target.value)} className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
              {scenarios.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <button onClick={run} disabled={loading} className="rounded-xl bg-cyan-500 px-6 py-3 font-bold text-slate-950 disabled:opacity-60">
              {loading ? "Running real IDS validation…" : "Run validation"}
            </button>
          </div>
        </section>

        {message && <div className="mt-6 rounded-2xl border border-rose-700 bg-rose-950/40 p-5 text-rose-200" role="alert">{message}</div>}

        {result && (
          <section className="mt-8 space-y-6" aria-live="polite">
            <div>
              <h2 className="text-2xl font-bold">{result.title}</h2>
              <p className="mt-2 text-slate-300">{result.explanation}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Status label="Overall" value={result.report.overallStatus} />
              <Status label="IDS layer" value={result.report.idsStatus} />
              <Status label="Project rules layer" value={result.report.projectRulesStatus} />
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
              <h3 className="font-bold">Governed profile provenance</h3>
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="text-slate-400">Profile</dt><dd>{result.report.profile?.familyKey}</dd></div>
                <div><dt className="text-slate-400">Version</dt><dd>{result.report.profile?.version}</dd></div>
                <div className="sm:col-span-2"><dt className="text-slate-400">SHA-256</dt><dd className="break-all font-mono text-xs">{result.report.profile?.sha256}</dd></div>
                <div><dt className="text-slate-400">Executor</dt><dd>{result.report.executor?.name} {result.report.executor?.version}</dd></div>
              </dl>
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <Findings title="IDS requirements" findings={idsFindings} />
              <Findings title="Project-specific rules" findings={projectFindings} />
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function Findings({ title, findings }: { title: string; findings: Finding[] }) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <h3 className="text-lg font-bold">{title}</h3>
      <ul className="mt-4 space-y-3">
        {findings.map((finding, index) => (
          <li key={`${finding.requirementId}-${finding.entityGuid ?? index}`} className="rounded-xl bg-slate-950 p-4">
            <div className={`text-xs font-bold uppercase ${finding.status === "pass" ? "text-emerald-300" : "text-rose-300"}`}>{finding.status}</div>
            <div className="mt-1 font-semibold">{finding.requirementName}</div>
            <p className="mt-1 text-sm text-slate-300">{finding.message}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
