"use client";

import { useMemo, useState } from "react";
import { Button } from "@heroui/react";

type Props = { asset: any; actorId: string; onClose: () => void };

function diagnostic(json: any, fallback: string) {
  const message = json?.message ?? json?.error ?? fallback;
  return json?.layer ? `${json.layer}: ${message}` : message;
}

export default function ReservationModal({ asset, actorId, onClose }: Props) {
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");
  const [evidence, setEvidence] = useState<any | null>(null);
  const [legacyAvailable, setLegacyAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [shadowConfirmed, setShadowConfirmed] = useState(false);

  const start = useMemo(() => startDate && startTime ? `${startDate}T${startTime}` : "", [startDate, startTime]);
  const end = useMemo(() => endDate && endTime ? `${endDate}T${endTime}` : "", [endDate, endTime]);
  const invalidate = () => { setEvidence(null); setLegacyAvailable(null); setError(null); setShadowConfirmed(false); };

  function validateInputs() {
    if (!actorId || !start || !end) return "A identidade de desenvolvimento ou o intervalo ainda não estão disponíveis.";
    if (new Date(end) <= new Date(start)) return "O fim tem de ser depois do início.";
    if (new Date(start) <= new Date()) return "O início não pode estar no passado.";
    return null;
  }

  async function legacyAvailability() {
    const response = await fetch(`/api/asset/availability/${asset.id}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(diagnostic(json, "Erro ao verificar disponibilidade."));
    setLegacyAvailable(Boolean(json?.data?.available));
  }

  async function checkEvidence() {
    const invalid = validateInputs();
    if (invalid) { setError(invalid); return; }
    setChecking(true); setError(null); setEvidence(null); setLegacyAvailable(null); setShadowConfirmed(false);
    try {
      const response = await fetch("/api/reservation/evidence", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId: asset.id, start, end }),
      });
      const json = await response.json().catch(() => null);
      if (response.status === 503 || response.status === 404) {
        await legacyAvailability();
      } else if (!response.ok) {
        throw new Error(diagnostic(json, "Não foi possível reunir a evidência."));
      } else {
        setEvidence(json?.data ?? json);
      }
    } catch (cause: any) {
      setError(cause?.message ?? "Não foi possível reunir a evidência.");
    } finally { setChecking(false); }
  }

  async function createReservation() {
    const invalid = validateInputs();
    if (invalid) { setError(invalid); return; }
    setCreating(true); setError(null);
    try {
      const response = await fetch("/api/reservation/request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId: asset.id, startTime: start, endTime: end,
          semanticEvidenceRunUuid: evidence?.runUuid ?? undefined }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) throw new Error(diagnostic(json, "O pedido não foi criado."));
      const result = json?.data ?? json;
      alert(`Pedido de reserva criado em estado ${result?.status ?? "pending"}.${result?.evidenceLinked ? " Evidence snapshot ligado." : ""}`);
      onClose();
    } catch (cause: any) { setError(cause?.message ?? "O pedido não foi criado."); }
    finally { setCreating(false); }
  }

  const semanticWarning = evidence && evidence.semanticEligibility?.outcome !== "eligible";
  const canCreate = Boolean(evidence || legacyAvailable) && (!semanticWarning || shadowConfirmed);

  return (
    <div className="fixed inset-0 bg-black/40 flex justify-center items-center z-50 p-4">
      <div className="bg-white p-6 rounded w-full max-w-4xl max-h-[94vh] overflow-y-auto shadow-lg">
        <h3 className="text-lg font-semibold mb-1">Pedido de reserva: {asset.name}</h3>
        <p className="text-xs text-slate-600 mb-4">A evidência semântica é shadow e não autentica, autoriza ou aprova. O SQL continua a decidir disponibilidade e conflitos.</p>

        <div className="grid md:grid-cols-2 gap-3">
          <label className="text-sm">Identidade atual da aplicação
            <input className="border rounded p-2 w-full bg-slate-50" readOnly value={actorId} />
            <span className="block text-xs text-slate-500 mt-1">Identidade local de desenvolvimento; não é uma conta autenticada e não pode ser alterada nesta página.</span>
          </label>
          <label className="text-sm">Asset
            <input className="border rounded p-2 w-full bg-slate-50" readOnly value={`${asset.name} (#${asset.id})`} />
          </label>
          <DateTime label="Início" date={startDate} time={startTime} setDate={(value: string) => { setStartDate(value); invalidate(); }} setTime={(value: string) => { setStartTime(value); invalidate(); }} />
          <DateTime label="Fim" date={endDate} time={endTime} setDate={(value: string) => { setEndDate(value); invalidate(); }} setTime={(value: string) => { setEndTime(value); invalidate(); }} />
        </div>

        <Button className="mt-4" color="secondary" onPress={checkEvidence} isLoading={checking}>Check evidence</Button>
        {error && <div className="mt-3 p-3 rounded bg-red-100 text-red-800">{error}</div>}
        {legacyAvailable !== null && <div className={`mt-3 p-3 rounded ${legacyAvailable ? "bg-green-100" : "bg-red-100"}`}>
          Evidence feature disabled; SQL availability: {legacyAvailable ? "available" : "conflict"}.
        </div>}

        {evidence && <EvidenceResult evidence={evidence} />}

        {semanticWarning && <label className="mt-4 flex gap-2 text-sm p-3 bg-amber-50 rounded">
          <input type="checkbox" checked={shadowConfirmed} onChange={(event) => setShadowConfirmed(event.target.checked)} />
          Compreendo que o resultado semântico é shadow e não bloqueante; quero submeter explicitamente à autoridade operacional SQL.
        </label>}

        <div className="flex justify-between mt-5">
          <Button variant="light" onPress={onClose}>Fechar</Button>
          <Button color="primary" onPress={createReservation} isLoading={creating} isDisabled={!canCreate}>
            Create reservation request
          </Button>
        </div>
      </div>
    </div>
  );
}

function DateTime({ label, date, time, setDate, setTime }: any) {
  return <label className="text-sm">{label}<div className="flex gap-2">
    <input type="date" className="border rounded p-2 w-1/2" value={date} onChange={(e) => setDate(e.target.value)} />
    <input type="time" className="border rounded p-2 w-1/2" value={time} onChange={(e) => setTime(e.target.value)} />
  </div></label>;
}

function EvidenceResult({ evidence }: { evidence: any }) {
  const findings = evidence.semanticEligibility?.findings ?? [];
  return <div className="mt-4 space-y-3 text-sm">
    <section className="border rounded p-3"><h4 className="font-semibold">Institutional actor evidence</h4>
      {evidence.actorEvidence.status !== "available" && <p className="mt-2 p-2 rounded bg-amber-50 text-amber-900">A conta atual não possui evidência institucional verificada. Este resultado é shadow, não bloqueante e não decide disponibilidade SQL.</p>}
      <p>Link: {evidence.actorEvidence.linkStatus} · Agent: {evidence.actorEvidence.agentUri ?? "not available"}</p>
      <p>Roles: {evidence.actorEvidence.roles?.map((role: any) => role.label).join(", ") || "none"}</p>
      <p>Organizations: {evidence.actorEvidence.organizations?.map((org: any) => org.label).join(", ") || "none"}</p>
      <p>Institutional version: {evidence.actorEvidence.institutionalVersion ?? "not available"}</p>
    </section>
    <section className="border rounded p-3"><h4 className="font-semibold">Resource semantic evidence</h4>
      <p>Asset UUID: {evidence.resourceEvidence.assetUuid ?? "not available"} · Tag: {evidence.resourceEvidence.tag ?? "not available"}</p>
      <p>Location: {evidence.resourceEvidence.location ?? "not available"} · Model version: {evidence.resourceEvidence.modelVersionUuid ?? "not available"}</p>
      <p>Manifestation GUID: {evidence.resourceEvidence.manifestationGuid ?? "not available"}</p>
    </section>
    <section className="border rounded p-3"><h4 className="font-semibold">Structural graph evidence</h4>
      <p>Status: {evidence.structuralEvidence.status} · Run: {evidence.structuralEvidence.validationRunUuid ?? "not available"} · Shapes: {evidence.structuralEvidence.shapesVersion ?? "not available"}</p>
    </section>
    <section className="border rounded p-3"><h4 className="font-semibold">Semantic eligibility — shadow only</h4>
      <p className="font-medium">Outcome: {evidence.semanticEligibility.outcome} (never binding)</p>
      <p>{evidence.semanticEligibility.policyFilename} · v{evidence.semanticEligibility.policyVersion} · SHA-256 {evidence.semanticEligibility.policyHash}</p>
      <div className="overflow-x-auto mt-2"><table className="w-full text-xs"><thead><tr><th className="text-left">Path</th><th className="text-left">Constraint</th><th className="text-left">Result</th></tr></thead><tbody>
        {(evidence.semanticEligibility.constraints ?? []).map((constraint: any, index: number) => {
          const failed = findings.some((finding: any) => finding.resultPath === constraint.path || finding.sourceShape === constraint.sourceShape);
          return <tr key={`${constraint.sourceShape}-${index}`} className="border-t"><td>{constraint.path ?? "node"}</td><td>{constraint.message ?? "Governed constraint"}</td><td>{failed ? "violation" : "satisfied"}</td></tr>;
        })}
      </tbody></table></div>
      {findings.length > 0 && <details className="mt-2"><summary>Detalhes técnicos das constraints</summary>{findings.map((finding: any, index: number) => <p className="text-red-700" key={index}>{finding.resultPath ?? "node"}: {finding.message}</p>)}</details>}
    </section>
    <section className={`border rounded p-3 ${evidence.availability.status === "available" ? "bg-green-50" : "bg-red-50"}`}>
      <h4 className="font-semibold">SQL temporal availability — authority: SQL</h4><p>Status: {evidence.availability.status}</p>
      {evidence.availability.conflicts?.map((conflict: any, index: number) => <p key={index}>{conflict.message}</p>)}
    </section>
    <p className="text-xs">Run {evidence.runUuid}. Check evidence did not create a reservation.</p>
  </div>;
}
