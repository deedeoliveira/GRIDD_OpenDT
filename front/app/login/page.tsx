"use client";

import { useEffect, useState } from "react";

type Account = { accountUuid: string; accountKey: string; displayLabel: string; status: string };

export default function Login() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/auth/local-accounts")
      .then((response) => response.json())
      .then((payload) => setAccounts(payload.data ?? []))
      .catch(() => setError("Não foi possível obter as contas locais."));
  }, []);

  async function login(accountKey: string) {
    const response = await fetch("/api/auth/local-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountKey }) });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.message ?? "Não foi possível iniciar sessão.");
      return;
    }
    const sessionResponse = await fetch("/api/auth/session", { cache: "no-store" });
    const session = await sessionResponse.json().catch(() => null);
    const area = session?.data?.applicationArea;
    if (area === "manager") window.location.assign("/dashboard");
    else if (area === "student") window.location.assign("/student");
    else setError("Esta conta não tem uma área disponível.");
  }

  return <main className="uminho-page flex items-center justify-center p-6">
    <section className="uminho-card w-full max-w-xl p-8">
      <p className="text-sm font-semibold uppercase tracking-[.16em]" style={{ color: "var(--uminho-primary)" }}>Universidade do Minho</p>
      <h1 className="mt-2 text-3xl font-semibold">Plataforma de Gestão de Edifícios</h1>
      <p className="mt-3 text-sm" style={{ color: "var(--text-secondary)" }}>Esta autenticação é local e destinada à demonstração.</p>
      {error && <p className="mt-3 text-red-700" role="alert">{error}</p>}
      <div className="mt-6 space-y-3" aria-label="Contas locais disponíveis">
        {accounts.map((account, index) => <button key={account.accountUuid} className="uminho-card block w-full p-4 text-left disabled:opacity-50" disabled={account.status !== "active"} onClick={() => login(account.accountKey)}>
          <span className="mr-3 inline-flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold text-white" style={{ background: "var(--uminho-primary)" }} aria-hidden="true">{index + 1}</span>
          <span className="font-medium">{account.displayLabel}</span><span className="ml-2 text-sm" style={{ color: "var(--text-secondary)" }}>({account.status === "active" ? "disponível" : "indisponível"})</span>
        </button>)}
      </div>
    </section>
  </main>;
}
