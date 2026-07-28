"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { capabilitiesOf, hasAnyManagement, noCapabilities, type Capabilities } from "@/lib/sessionCapabilities.mts";

export default function ManagerNavigation() {
  const [label, setLabel] = useState("Gestor");
  const [capabilities, setCapabilities] = useState<Capabilities>(noCapabilities);

  useEffect(() => {
    void fetch("/api/auth/session", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json().catch(() => null);
      const session = payload?.data;
      const derived = capabilitiesOf(session);
      // Management navigation requires at least one management capability. An
      // account with only reserveResources belongs in the reservation workspace.
      if (!response.ok || !hasAnyManagement(derived)) {
        window.location.assign(derived.reserveResources ? "/student" : "/login");
        return;
      }
      setCapabilities(derived);
      if (typeof session.displayLabel === "string") setLabel(session.displayLabel);
    }).catch(() => window.location.assign("/login"));
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  }

  return <nav className="uminho-nav mb-8 flex flex-wrap items-center justify-between gap-3 pb-4" aria-label="Navegação do gestor">
    <div><p className="text-xs uppercase tracking-[.2em]" style={{ color: "var(--uminho-primary)" }}>Sessão de gestor</p><p className="text-sm" style={{ color: "var(--text-secondary)" }}>{label}</p></div>
    <div className="flex flex-wrap items-center gap-2">
      <a className="rounded-lg px-3 py-2" href="/dashboard">Início</a>
      <Link className="rounded-lg px-3 py-2" href="/student">Reservar recursos</Link>
      {capabilities.bimManagement && <Link className="rounded-lg px-3 py-2" href="/dashboard?workspace=models">Gestão BIM</Link>}
      {capabilities.operationalManagement && <Link className="rounded-lg px-3 py-2" href="/dashboard/reservations">Gestão de reservas</Link>}
      <button className="uminho-secondary-button px-3 py-2" onClick={logout}>Terminar sessão</button>
    </div>
  </nav>;
}
