import MySQLDatabase from "./mysqlDatabase.ts";
import { getReservationRequestValidator, logPolicyDecision } from "../policies/policyProvider.ts";

class ReservationDatabase {
  private db: MySQLDatabase;

  constructor() {
    this.db = new MySQLDatabase();
    this.db.connect();
  }

  /* -------------------------------------
      CHECK CONFLICTS
  ------------------------------------- */

  async hasApprovedConflict(assetId: number, start: Date, end: Date) {
    await this.db.checkConnection();

    const [rows]: any = await this.db.connection.execute(`
      SELECT COUNT(*) as count
      FROM res_reservations
      WHERE asset_id = :assetId
      AND status IN ('approved','in_use','no_show')
      AND start_time < :end
      AND end_time > :start
    `, {
      assetId,
      start,
      end
    });

    return rows[0].count > 0;
  }

  async hasActorConflict(assetId: number, actorId: string, start: Date, end: Date) {
    await this.db.checkConnection();

    const [rows]: any = await this.db.connection.execute(`
      SELECT COUNT(*) as count
      FROM res_reservations
      WHERE asset_id = :assetId
      AND actor_id = :actorId
      AND status IN ('pending','approved')
      AND start_time < :end
      AND end_time > :start
    `, {
      assetId,
      actorId,
      start,
      end
    });

    return rows[0].count > 0;
  }

  /* -------------------------------------
      CREATE RESERVATION
  ------------------------------------- */

  async createReservation(
    assetId: number,
    actorId: string,
    start: Date,
    end: Date
  ) {
    await this.markExpiredReservationsAsNoShow();
    await this.db.checkConnection();

    // Validação de submissão delegada na política configurada (default: legacy,
    // que reproduz as validações técnicas da baseline: fim > início, início no
    // futuro — por esta ordem). Não é aprovação: um pedido permitido entra
    // como 'pending'. Conflitos temporais continuam abaixo, fora da política.
    const validator = getReservationRequestValidator();
    const validation = await validator.validate(
      { assetId, actorId, startTime: start, endTime: end },
      {}
    );

    logPolicyDecision("reservation_request", validation, { assetId, actorId });

    if (validation.decision !== "allow") {
      throw new Error(validation.reasons[0] ?? "Reservation request rejected by policy");
    }

    // 1️⃣ Check approved conflict
    const approvedConflict = await this.hasApprovedConflict(assetId, start, end);
    if (approvedConflict) {
      throw new Error("Asset already reserved for this period");
    }

    // 2️⃣ Check actor self-conflict
    const actorConflict = await this.hasActorConflict(assetId, actorId, start, end);
    if (actorConflict) {
      throw new Error("You already have a reservation overlapping this period");
    }

    // 3️⃣ Insert pending reservation
    const [result]: any = await this.db.connection.execute(`
      INSERT INTO res_reservations (
        asset_id,
        actor_id,
        start_time,
        end_time,
        status
      )
      VALUES (:assetId, :actorId, :start, :end, 'pending')
    `, {
      assetId,
      actorId,
      start,
      end
    });

    return result.insertId;
  }

  async checkIn(reservationId: number, actorId: string) {
    await this.markExpiredReservationsAsNoShow();
    await this.db.checkConnection();

    const GRACE_BEFORE_MIN = 20; // pode entrar 20 min antes
    const GRACE_AFTER_MIN = 10;  // pode entrar até 10 min depois do início

    const [rows]: any = await this.db.connection.execute(`
      SELECT *
      FROM res_reservations
      WHERE id = :reservationId
        AND actor_id = :actorId
        AND status = 'approved'
        AND NOW() >= DATE_SUB(start_time, INTERVAL :before MINUTE)
        AND NOW() <= DATE_ADD(start_time, INTERVAL :after MINUTE)
      LIMIT 1
    `, {
      reservationId,
      actorId,
      before: GRACE_BEFORE_MIN,
      after: GRACE_AFTER_MIN
    });

    if (!rows.length) {
      throw new Error(
        "Check-in not allowed: outside allowed time window or no approved reservation"
      );
    }

    const reservation = rows[0];

    if (reservation.checkin_time) {
      throw new Error('Already checked in');
    }

    await this.db.connection.execute(`
      UPDATE res_reservations
      SET status = 'in_use',
          checkin_time = NOW()
      WHERE id = :id
    `, { id: reservation.id });

    return {
      message: 'Check-in successful',
      reservationId: reservation.id
    };
  }


  async checkOut(reservationId: number, actorId: string) {
    await this.markExpiredReservationsAsNoShow();
    await this.db.checkConnection();

    console.log("checkout em reservationDatase - reservationID:", reservationId);
    console.log("checkout em reservationDatase - actorId:", actorId);

    const [rows]: any = await this.db.connection.execute(`
      SELECT *
      FROM res_reservations
      WHERE id = :reservationId
      AND actor_id = :actorId
      AND status IN ('in_use','overdue')
      LIMIT 1
    `, { reservationId, actorId });

    if (!rows.length) {
      throw new Error("No active reservation to checkout");
    }

    await this.db.connection.execute(`
      UPDATE res_reservations
      SET status = 'completed'
      WHERE id = :reservationId
    `, { reservationId });

    return {
      message: "Checkout successful",
      reservationId
    };
  }


  async cancelReservation(reservationId: number, actorId: string) {
    await this.markExpiredReservationsAsNoShow();
    await this.db.checkConnection();

    const [rows]: any = await this.db.connection.execute(`
      SELECT *
      FROM res_reservations
      WHERE id = :id
    `, { id: reservationId });

    if (!rows.length) {
      throw new Error("Reservation not found");
    }

    const reservation = rows[0];
    const now = new Date();
    const startTime = new Date(reservation.start_time);

    // Só o próprio ator pode cancelar
    if (reservation.actor_id !== actorId) {
      throw new Error("Not authorized to cancel this reservation");
    }

    // Não pode cancelar in_use (nem overdue)
    if (['in_use','overdue'].includes(reservation.status)) {
      throw new Error("Cannot cancel reservation that is in use");
    }

    // Só pending ou approved
    if (!['pending','approved'].includes(reservation.status)) {
      throw new Error("Reservation cannot be cancelled");
    }

    // Regra 24h — aplica-se apenas a reservas já aprovadas;
    // uma reserva pendente pode ser cancelada a qualquer momento
    if (reservation.status === 'approved') {
      const diffMs = startTime.getTime() - now.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);

      if (diffHours < 24) {
        throw new Error("Cancellation allowed only up to 24h before start time");
      }
    }

    await this.db.connection.execute(`
      UPDATE res_reservations
      SET status = 'cancelled'
      WHERE id = :id
    `, { id: reservationId });

    return { message: "Reservation cancelled" };
  }

  /* -------------------------------------
      AUTO STATUS UPDATES (lazy, corridos
      no início de cada operação)
  ------------------------------------- */

  async markExpiredReservationsAsNoShow() {
    await this.db.checkConnection();

    // approved sem check-in até 10 min depois do início → no_show
    await this.db.connection.execute(`
      UPDATE res_reservations
      SET status = 'no_show'
      WHERE status = 'approved'
        AND checkin_time IS NULL
        AND NOW() > DATE_ADD(start_time, INTERVAL 10 MINUTE)
    `);

    // in_use cujo período já terminou sem checkout → overdue.
    // O ator continua obrigado a fazer checkout (overdue é aceite no checkout),
    // mas o sistema passa a distinguir "em uso" de "terminada sem checkout".
    await this.db.connection.execute(`
      UPDATE res_reservations
      SET status = 'overdue'
      WHERE status = 'in_use'
        AND NOW() > end_time
    `);
  }
  
  /* -------------------------------------
    GET reservations by asset
  ------------------------------------- */
  async getReservationsByAsset(assetId: number) {
    await this.markExpiredReservationsAsNoShow();
    await this.db.checkConnection();

    const [rows]: any = await this.db.connection.execute(`
      SELECT *
      FROM res_reservations
      WHERE asset_id = :assetId
      ORDER BY start_time ASC
    `, { assetId });

    return rows;
  }

  /* -------------------------------------
    GET reservations by actor
  ------------------------------------- */
  async getReservationsByActor(actorId: string) {
    await this.markExpiredReservationsAsNoShow();
    await this.db.checkConnection();

    const [rows]: any = await this.db.connection.execute(
      `
      SELECT *
      FROM res_reservations
      WHERE actor_id = ?
      ORDER BY start_time DESC
      `,
      [actorId]
    );

    return rows;
  }




}

export default new ReservationDatabase();
