"use client";

import { useEffect, useState } from "react";
import { Button } from "@heroui/react";

type ReservationRow = {
  id: number;
  asset_id: number;
  actor_id: string;
  start_time: string;
  end_time: string;
  status: string;
};

type Props = {
  actorId: string;
  onClose: () => void;
  onCheckIn: (reservationId: number) => void;
};

export default function YourReservationsModal({
  actorId,
  onClose,
  onCheckIn
}: Props) {

  const [reservations, setReservations] = useState<ReservationRow[]>([]);
  const [loading, setLoading] = useState(false);

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

  async function fetchReservations() {
    setLoading(true);

    const res = await fetch(`/api/reservation/actor/${actorId}`);
    const json = await res.json();

    setReservations(json?.data ?? json ?? []);
    setLoading(false);
  }

  useEffect(() => {
    fetchReservations();
  }, [actorId]);

  const approved = reservations.filter(r => r.status === "approved");
  const inUse = reservations.filter(r => r.status === "in_use");
  const finished = reservations.filter(
    r => !["approved", "in_use"].includes(r.status)
  );

  return (
    <div className="fixed inset-0 bg-black/40 flex justify-center items-center z-50">
      <div className="bg-white p-6 rounded w-[650px] shadow-lg">

        <h3 className="text-lg font-semibold mb-4">
          Your Reservations
        </h3>

        {loading && <div>Loading...</div>}

        {!loading && (
          <div className="flex flex-col gap-6">

            <Section
              title="Approved"
              rows={approved}
              formatDateTime={formatDateTime}
              showCheckIn
              onCheckIn={onCheckIn}
            />

            <Section
              title="In Use"
              rows={inUse}
              formatDateTime={formatDateTime}
            />

            <Section
              title="Finished"
              rows={finished}
              formatDateTime={formatDateTime}
            />

          </div>
        )}

        <div className="flex justify-end mt-6">
          <Button variant="light" onPress={onClose}>
            Close
          </Button>
        </div>

      </div>
    </div>
  );
}

function Section({
  title,
  rows,
  formatDateTime,
  showCheckIn = false,
  onCheckIn
}: any) {

  if (!rows.length) return null;

  return (
    <div>
      <h4 className="font-semibold mb-2">{title}</h4>

      <div className="max-h-48 overflow-y-auto text-sm border rounded p-3">

        {rows.map((r: any) => (
          <div key={r.id} className="border-b py-3 flex justify-between items-center">

            <div>
              <div className="text-xs text-gray-500">
                Asset ID: {r.asset_id}
              </div>

              <div>
                {formatDateTime(r.start_time)} → {formatDateTime(r.end_time)}
              </div>
            </div>

            {showCheckIn && (
              <Button
                size="sm"
                color="primary"
                onPress={() => onCheckIn(r.id)}
              >
                Check-in
              </Button>
            )}

          </div>
        ))}

      </div>
    </div>
  );
}
