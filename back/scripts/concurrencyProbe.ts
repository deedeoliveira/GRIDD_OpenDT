/**
 * Sonda de concorrência REAL por HTTP (Prompt 6, §11/§18.6) — dispara pedidos
 * verdadeiramente simultâneos contra o backend A CORRER e verifica os
 * invariantes de concorrência na base real.
 *
 * NÃO usa sleeps frágeis: os pedidos partem juntos via Promise.all (barreira).
 * READ-ONLY sobre a configuração; escreve apenas dados de teste óbvios
 * (reservas do ator 'probe-*', ativos 'Probe*') que podem ser removidos com
 * scripts/cleanupNonModelledGraphData.ts (não modelados) ou à mão (reservas).
 *
 * Uso (backend em http://localhost:3001):
 *   cd back
 *   npx tsx scripts/concurrencyProbe.ts reservation <assetId>   # §11.1: 10 rondas de par incompatível (mesmo ator)
 *   npx tsx scripts/concurrencyProbe.ts idempotency             # §11.3: 5 registos simultâneos com a MESMA chave
 *   npx tsx scripts/concurrencyProbe.ts movement <assetId>      # §11.4: 2 movimentos simultâneos (chaves diferentes)
 *
 * Resultado esperado:
 *   reservation → cada ronda: accepted=1 rejected=1 (nunca 2 aceites)
 *   idempotency → 5 respostas com o MESMO assetUuid/operationUuid; 1 ativo
 *   movement    → ambos 200 por ordem; /location-history mostra 1 corrente
 */
const API = process.env.PROBE_API_BASE ?? "http://localhost:3001/api";

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${API}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

async function probeReservation(assetId: number): Promise<void> {
    console.log(`§11.1 — pares de reservas incompatíveis simultâneas (asset ${assetId}, mesmo ator)`);
    let doubleAccepts = 0;
    for (let round = 0; round < 10; round++) {
        const base = Date.now() + (round + 2) * 86_400_000; // dias diferentes por ronda
        const actor = `probe-${round}-${base}`;
        const payload = {
            assetId,
            actorId: actor,
            startTime: new Date(base).toISOString(),
            endTime: new Date(base + 3_600_000).toISOString(),
        };
        const [a, b] = await Promise.all([post("/reservation/request", payload), post("/reservation/request", payload)]);
        const accepted = [a, b].filter((r) => r.status === 201).length;
        const rejected = [a, b].filter((r) => r.status !== 201).length;
        console.log(`  ronda ${round}: accepted=${accepted} rejected=${rejected}`);
        if (accepted !== 1) doubleAccepts += 1;
    }
    if (doubleAccepts > 0) {
        console.error(`FALHA: ${doubleAccepts} ronda(s) sem exatamente 1 aceite`);
        process.exit(1);
    }
    console.log("OK: todas as rondas com exatamente 1 aceite e 1 rejeitada.");
}

async function probeIdempotency(): Promise<void> {
    console.log("§11.3 — 5 registos simultâneos com a MESMA registrationKey");
    const key = `probe-idem-${Date.now()}`;
    const payload = {
        registrationKey: key,
        name: "Probe idempotência",
        assetType: "PortableEquipment",
        resourceKind: "equipment",
    };
    const results = await Promise.all(Array.from({ length: 5 }, () => post("/asset/non-modelled", payload)));
    const uuids = new Set(results.map((r) => r.json?.data?.assetUuid).filter(Boolean));
    const opUuids = new Set(results.map((r) => r.json?.data?.operation?.operationUuid).filter(Boolean));
    console.log(`  statuses: ${results.map((r) => r.status).join(", ")}`);
    console.log(`  assetUuids distintos: ${uuids.size} | operações distintas: ${opUuids.size}`);
    if (uuids.size !== 1 || opUuids.size !== 1) {
        console.error("FALHA: as chamadas não convergiram para um único ativo/operação");
        process.exit(1);
    }
    console.log("OK: um único ativo, uma única operação — idempotência sob corrida confirmada.");
}

async function probeMovement(assetId: number): Promise<void> {
    console.log(`§11.4 — 2 movimentos simultâneos do asset ${assetId} (chaves diferentes)`);
    const statusRes = await fetch(`${API}/asset/non-modelled/${assetId}/projection-status`);
    const status = await statusRes.json();
    const currentSpaceId = status?.data?.currentLocation?.spaceId;
    if (!currentSpaceId) {
        console.error("o ativo não tem localização corrente — regista-o primeiro com initialSpaceId");
        process.exit(1);
    }
    // move para o próprio espaço e para outro (ids 1/2 assumidos do roteiro §20)
    const targets = [currentSpaceId === 1 ? 2 : 1, currentSpaceId];
    const stamp = Date.now();
    const moveResults = await Promise.all(targets.map((newSpaceId, i) =>
        post(`/asset/non-modelled/${assetId}/location`, { movementKey: `probe-mv-${stamp}-${i}`, newSpaceId })));
    console.log(`  statuses: ${moveResults.map((r) => r.status).join(", ")}`);

    const historyRes = await fetch(`${API}/asset/non-modelled/${assetId}/location-history`);
    const history = await historyRes.json();
    const currents = (history?.data ?? []).filter((h: any) => h.validTo === null || h.valid_to === null);
    console.log(`  correntes no histórico: ${currents.length}`);
    if (currents.length !== 1) {
        console.error("FALHA: mais de uma localização corrente");
        process.exit(1);
    }
    console.log("OK: movimentos serializados — uma única localização corrente, histórico consistente.");
}

const [mode, idArg] = process.argv.slice(2);
(async () => {
    if (mode === "reservation" && idArg) return probeReservation(Number(idArg));
    if (mode === "idempotency") return probeIdempotency();
    if (mode === "movement" && idArg) return probeMovement(Number(idArg));
    console.log("uso: npx tsx scripts/concurrencyProbe.ts reservation <assetId> | idempotency | movement <assetId>");
    process.exit(2);
})().catch((e) => { console.error(e.message ?? e); process.exit(1); });
