"use client";

import { useState } from "react";
import { Button } from "@heroui/react";

type ReservationRow = {
  id: number;
  actor_id: string;
  start_time: string;
  end_time: string;
  status: string;
};

type Props = {
  asset: any;
  actorId: string;
  onClose: () => void;
};

export default function ReservationModal({
  asset,
  actorId,
  onClose
}: Props) {
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reservations, setReservations] = useState<ReservationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasCheckedAvailability, setHasCheckedAvailability] = useState(false);

  function formatDateTime(dateString: string) {
    const d = new Date(dateString);
    const pad = (n: number) => n.toString().padStart(2, "0");

    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      " " +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes())
    );
  }

  async function checkAvailability() {
    if (!startDate || !startTime || !endDate || !endTime) return;

    const start = `${startDate}T${startTime}`;
    const end = `${endDate}T${endTime}`;

    setLoading(true);
    setHasCheckedAvailability(true);

    // 1️⃣ Verificar disponibilidade
    const res = await fetch(
      `/api/asset/availability/${asset.id}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
    );

    const json = await res.json();

    setAvailable(json?.data?.available ?? false);

    // 2️⃣ Buscar reservas existentes
    const resList = await fetch(`/api/reservation/asset/${asset.id}`);
    const listJson = await resList.json();

    setReservations(listJson?.data ?? listJson ?? []);

    setLoading(false);
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex justify-center items-center z-50">
      <div className="bg-white p-6 rounded w-[500px] shadow-lg">

        <h3 className="text-lg font-semibold mb-4">
          Reservar: {asset.name}
        </h3>

        <div className="flex flex-col gap-3">

          <label className="text-sm font-medium">Início</label>
          <div className="flex gap-2 items-center">
            <input
              type="date"
              className="border rounded p-2 w-1/2"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
            <div className="flex gap-1 items-center w-1/2">
              <select
                className="border rounded p-2 w-full"
                value={startTime.split(":")[0] ?? ""}
                onChange={(e) => setStartTime(e.target.value + ":" + (startTime.split(":")[1] ?? "00"))}
              >
                <option value="">HH</option>
                {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map(h => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
              <span>:</span>
              <select
                className="border rounded p-2 w-full"
                value={startTime.split(":")[1] ?? ""}
                onChange={(e) => setStartTime((startTime.split(":")[0] ?? "00") + ":" + e.target.value)}
              >
                <option value="">MM</option>
                {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")).map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>

          <label className="text-sm font-medium">Fim</label>
          <div className="flex gap-2 items-center">
            <input
              type="date"
              className="border rounded p-2 w-1/2"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
            <div className="flex gap-1 items-center w-1/2">
              <select
                className="border rounded p-2 w-full"
                value={endTime.split(":")[0] ?? ""}
                onChange={(e) => setEndTime(e.target.value + ":" + (endTime.split(":")[1] ?? "00"))}
              >
                <option value="">HH</option>
                {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map(h => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
              <span>:</span>
              <select
                className="border rounded p-2 w-full"
                value={endTime.split(":")[1] ?? ""}
                onChange={(e) => setEndTime((endTime.split(":")[0] ?? "00") + ":" + e.target.value)}
              >
                <option value="">MM</option>
                {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")).map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>

          <Button onPress={checkAvailability} isLoading={loading}>
            Verificar disponibilidade
          </Button>

          {/* Resultado de disponibilidade */}
          {hasCheckedAvailability && available !== null && (
            <div className={`p-2 rounded ${available ? "bg-green-100" : "bg-red-100"}`}>
              {available
                ? "Disponível nesse período"
                : "Indisponível nesse período"}
            </div>
          )}

          {/* Reservas existentes (apenas após verificar) */}
          {hasCheckedAvailability && !loading && (
            <div className="mt-4">
              <h4 className="font-semibold mb-2">Reservas existentes:</h4>
              <div className="max-h-40 overflow-y-auto text-sm">
                {reservations.length === 0 ? (
                  <div>Sem reservas</div>
                ) : (
                  reservations.map((r) => (
                    <div key={r.id} className="border-b py-1">
                      {formatDateTime(r.start_time)} →{" "}
                      {formatDateTime(r.end_time)} ({r.status})
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          <div className="flex justify-end mt-4">
            <Button variant="light" onPress={onClose}>
              Fechar
            </Button>
          </div>

        </div>
      </div>
    </div>
  );
}
