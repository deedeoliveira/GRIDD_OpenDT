import MySQLDatabase from "./mysqlDatabase.ts";

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

    const now = new Date();

    // 🚫 Não permitir reservas retroativas
    if (start <= now) {
      throw new Error("Cannot create reservation in the past");
    }

    // 🚫 Período inválido
    if (end <= start) {
      throw new Error("End time must be after start time");
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

  async checkIn(assetId: number, actorId: string) {
    await this.markExpiredReservationsAsNoShow();
    await this.db.checkConnection();

    const GRACE_BEFORE_MIN = 20; // pode entrar 20 min antes
    const GRACE_AFTER_MIN = 10;  // pode entrar até 10 min depois do início

    const [rows]: any = await this.db.connection.execute(`
      SELECT *
      FROM res_reservations
      WHERE asset_id = :assetId
      AND actor_id = :actorId
      AND status = 'approved'
      AND NOW() >= DATE_SUB(start_time, INTERVAL :before MINUTE)
      AND NOW() <= DATE_ADD(start_time, INTERVAL :after MINUTE)
      LIMIT 1
    `, {
      assetId,
      actorId,
      before: GRACE_BEFORE_MIN,
      after: GRACE_AFTER_MIN
    });

    if (!rows.length) {
      throw new Error('Check-in not allowed: outside allowed time window or no approved reservation');
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

  async checkOut(assetId: number, actorId: string) {
    await this.markExpiredReservationsAsNoShow();
    await this.db.checkConnection();

    const [rows]: any = await this.db.connection.execute(`
      SELECT *
      FROM res_reservations
      WHERE asset_id = :assetId
      AND actor_id = :actorId
      AND status = 'in_use'
      LIMIT 1
    `, { assetId, actorId });

    if (!rows.length) {
      throw new Error("No active reservation to checkout");
    }

    const reservation = rows[0];

    await this.db.connection.execute(`
      UPDATE res_reservations
      SET status = 'completed'
      WHERE id = :id
    `, { id: reservation.id });

    return {
      message: "Checkout successful",
      reservationId: reservation.id
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

    // Não pode cancelar in_use
    if (reservation.status === 'in_use') {
      throw new Error("Cannot cancel reservation that is in use");
    }

    // Só pending ou approved
    if (!['pending','approved'].includes(reservation.status)) {
      throw new Error("Reservation cannot be cancelled");
    }

    // Regra 24h
    const diffMs = startTime.getTime() - now.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    if (diffHours < 24) {
      throw new Error("Cancellation allowed only up to 24h before start time");
    }

    await this.db.connection.execute(`
      UPDATE res_reservations
      SET status = 'cancelled'
      WHERE id = :id
    `, { id: reservationId });

    return { message: "Reservation cancelled" };
  }

  /* -------------------------------------
      AUTO NO-SHOW UPDATE
  ------------------------------------- */

  async markExpiredReservationsAsNoShow() {
    await this.db.checkConnection();

    await this.db.connection.execute(`
      UPDATE res_reservations
      SET status = 'no_show'
      WHERE status = 'approved'
        AND checkin_time IS NULL
        AND NOW() > DATE_ADD(start_time, INTERVAL 10 MINUTE)
    `);
  }

}

export default new ReservationDatabase();
