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

  return <nav className="mb-8 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4" aria-label="Navegação do gestor">
    <div><p className="text-xs uppercase tracking-[.2em] text-cyan-300">Sessão de gestor</p><p className="text-sm text-slate-300">{label}</p></div>
    <div className="flex flex-wrap items-center gap-2">
      <Link className="rounded-lg px-3 py-2 hover:bg-slate-800" href="/dashboard">Modelos</Link>
      <Link className="rounded-lg px-3 py-2 hover:bg-slate-800" href="/dashboard/reservations">Reservas e decisões</Link>
      <button className="rounded-lg border border-slate-600 px-3 py-2" onClick={logout}>Terminar sessão</button>
    </div>
  </nav>;
}
