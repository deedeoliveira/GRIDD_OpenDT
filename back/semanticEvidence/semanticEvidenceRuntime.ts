import { ReservationSemanticEvidenceService } from "./reservationSemanticEvidenceService.ts";

let current: ReservationSemanticEvidenceService | null = null;

export function getReservationSemanticEvidenceService(): ReservationSemanticEvidenceService {
    current ??= new ReservationSemanticEvidenceService();
    return current;
}

export function resetReservationSemanticEvidenceService(): void { current = null; }
