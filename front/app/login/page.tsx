"use client";

import { useEffect, useState } from "react";

type Account = { accountUuid: string; accountKey: string; displayLabel: string; status: string };

export default function Login() {
  const [accounts, setAccounts] = useState<Account[]>([]); const [error, setError] = useState("");
  useEffect(() => { void fetch("/api/auth/local-accounts").then((response) => response.json()).then((payload) => setAccounts(payload.data ?? [])).catch(() => setError("Não foi possível obter as contas locais.")); }, []);
  async function login(accountKey: string) {
    const response = await fetch("/api/auth/local-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountKey }) });
    if (!response.ok) { const payload = await response.json().catch(() => null); setError(payload?.message ?? "Não foi possível iniciar sessão."); return; }
    const sessionResponse = await fetch("/api/auth/session", { cache: "no-store" }); const session = await sessionResponse.json().catch(() => null); const area = session?.data?.applicationArea;
    if (area === "manager") window.location.assign("/dashboard"); else if (area === "student") window.location.assign("/student"); else setError("Esta conta não tem uma área disponível.");
  }
  return <main className="mx-auto max-w-xl p-8"><p className="text-sm font-semibold uppercase tracking-[.2em] text-cyan-700">Demonstração de investigação</p><h1 className="mt-2 text-3xl font-semibold">Iniciar sessão</h1><p className="mt-2 text-sm text-slate-600">Escolha uma conta sintética para abrir a área correspondente. Esta autenticação é local e destinada à demonstração.</p>{error && <p className="mt-3 text-red-700" role="alert">{error}</p>}<div className="mt-5 space-y-3">{accounts.map((account) => <button key={account.accountUuid} className="block w-full rounded border p-3 text-left disabled:opacity-50" disabled={account.status !== "active"} onClick={() => login(account.accountKey)}><span className="font-medium">{account.displayLabel}</span><span className="ml-2 text-sm text-slate-600">({account.status === "active" ? "disponível" : "indisponível"})</span></button>)}</div></main>;
}
