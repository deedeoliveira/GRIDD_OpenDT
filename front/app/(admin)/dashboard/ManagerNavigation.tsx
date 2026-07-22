"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export default function ManagerNavigation() {
  const [label, setLabel] = useState("Gestor");

  useEffect(() => {
    void fetch("/api/auth/session", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json().catch(() => null);
      const session = payload?.data;
      if (!response.ok || session?.applicationArea !== "manager") {
        window.location.assign(session?.applicationArea === "student" ? "/student" : "/login");
        return;
      }
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
      <Link className="rounded-lg px-3 py-2" href="/dashboard?workspace=models">Gerir modelos</Link>
      <Link className="rounded-lg px-3 py-2" href="/dashboard/reservations">Reservas e decisões</Link>
      <button className="uminho-secondary-button px-3 py-2" onClick={logout}>Terminar sessão</button>
    </div>
  </nav>;
}
