import MySQLDatabase from "./mysqlDatabase.ts";
import { getReservationRequestValidator, logPolicyDecision } from "../policies/policyProvider.ts";
import { logConcurrencyEvent, newCorrelationId, withDeadlockRetry } from "./concurrencyControl.ts";

/**
 * Reservas (revisto no Prompt 6 — concorrência; ADR-0030).
 *
 * createReservation corre agora numa TRANSAÇÃO ÚNICA com lock por asset:
 * a primeira instrução da transação é SELECT ... FOR UPDATE na linha de
 * `assets`, o que serializa todas as criações de reserva do MESMO asset
 * (pedidos concorrentes do mesmo processo e de processos diferentes) sem
 * bloquear ativos diferentes. Verificações, snapshot e INSERT acontecem na
 * mesma fronteira transacional — a corrida verificar→inserir foi eliminada
 * na base de dados, não no frontend nem em memória.
 *
 * ESTADOS BLOQUEANTES (auditados e PRESERVADOS do comportamento anterior):
 *  - approved / in_use / no_show bloqueiam qualquer ator (hasApprovedConflict);
 *  - pending NÃO bloqueia terceiros; pending+approved bloqueiam o próprio
 *    ator (hasActorConflict). Nada disto foi alterado.
 *
 * Transições de estado usam compare-and-set (UPDATE condicionado ao estado
 * atual + affectedRows): transições concorrentes incompatíveis têm exatamente
 * um vencedor; o perdedor recebe o MESMO erro que receberia em execução
 * sequencial. A máquina de estados não mudou.
 */
class ReservationDatabase {
  private db: MySQLDatabase;

  constructor() {
    this.db = new MySQLDatabase();
    this.db.connect();
  }

  /* -------------------------------------
      CHECK CONFLICTS
  ------------------------------------- */

  async hasApprovedConflict(assetId: number, start: Date, end: Date, executor?: any) {
    await this.db.checkConnection();

    const [rows]: any = await (executor ?? this.db.connection).execute(`
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

  async hasActorConflict(assetId: number, actorId: string, start: Date, end: Date, executor?: any) {
    await this.db.checkConnection();

    const [rows]: any = await (executor ?? this.db.connection).execute(`
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
      CREATE RESERVATION (atómica)
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
    // como 'pending'. Conflitos temporais são verificados DENTRO da transação.
    const validator = getReservationRequestValidator();
    const validation = await validator.validate(
      { assetId, actorId, startTime: start, endTime: end },
      {}
    );

    logPolicyDecision("reservation_request", validation, { assetId, actorId });

    if (validation.decision !== "allow") {
      throw new Error(validation.reasons[0] ?? "Reservation request rejected by policy");
    }

    const correlationId = newCorrelationId();

    // Deadlocks InnoDB (1213) têm retry limitado; erros de negócio propagam
    // imediatamente (withDeadlockRetry nunca repete erros não-deadlock).
    return withDeadlockRetry("create_reservation", () => this.db.withTransaction(async (conn) => {
      logConcurrencyEvent("reservation_transaction_started", { assetId, correlationId });

      // LOCK POR ASSET — PRIMEIRA instrução da transação (regra de correção,
      // não de estilo: em REPEATABLE READ o snapshot é fixado na primeira
      // leitura; ao bloquear aqui, todas as leituras seguintes veem as
      // reservas comitadas por quem detinha o lock antes de nós).
      const [lifecycleRows]: any = await conn.execute(
        "SELECT lifecycle_status, source, reservable, asset_uuid FROM assets WHERE id = :assetId LIMIT 1 FOR UPDATE",
        { assetId }
      );

      // (Prompt 4) Ciclo de vida do ativo persistente: ausente/pendente de
      // reconciliacao/retirado nao aceita NOVAS reservas (as existentes ficam)
      if (lifecycleRows.length && lifecycleRows[0].lifecycle_status && lifecycleRows[0].lifecycle_status !== 'active') {
        throw new Error(`Asset is not available for new reservations (lifecycle: ${lifecycleRows[0].lifecycle_status})`);
      }

      // (Prompt 5B) Ativo NÃO modelado (projeção do grafo, source='graph'):
      // reservável APENAS quando a projeção SQL está completa — decisão de
      // política allow (reservable=1), localização corrente válida num espaço
      // ATIVO e nenhuma operação de sincronização incompleta. Tudo verificado
      // em SQL — o Fuseki NUNCA é consultado ao criar reservas, e uma falha
      // posterior do grafo não invalida projeções já concluídas.
      if (lifecycleRows.length && lifecycleRows[0].source === 'graph') {
        if (!lifecycleRows[0].reservable) {
          throw new Error("Asset is not reservable (reservability policy has not allowed it)");
        }

        const [locationRows]: any = await conn.execute(`
          SELECT ala.id
          FROM asset_location_assignments ala
          INNER JOIN spaces s ON s.id = ala.space_id
          WHERE ala.asset_id = :assetId
            AND ala.valid_to IS NULL
            AND s.status = 'active'
          LIMIT 1
        `, { assetId });

        if (!locationRows.length) {
          throw new Error("Asset has no valid current location — new reservations are blocked until the location is available");
        }

        const [pendingSyncRows]: any = await conn.execute(`
          SELECT COUNT(*) AS n
          FROM semantic_sync_operations
          WHERE asset_uuid = :assetUuid
            AND status NOT IN ('completed', 'failed_terminal')
        `, { assetUuid: lifecycleRows[0].asset_uuid });

        if (Number(pendingSyncRows[0]?.n ?? 0) > 0) {
          throw new Error("Asset has a pending graph synchronization — new reservations are blocked until it completes");
        }
      }

      // 1️⃣ Check approved conflict (dentro da transação, sob o lock do asset)
      const approvedConflict = await this.hasApprovedConflict(assetId, start, end, conn);
      if (approvedConflict) {
        logConcurrencyEvent("reservation_conflict_detected", { assetId, kind: "asset_overlap", correlationId });
        throw new Error("Asset already reserved for this period");
      }

      // 2️⃣ Check actor self-conflict
      const actorConflict = await this.hasActorConflict(assetId, actorId, start, end, conn);
      if (actorConflict) {
        logConcurrencyEvent("reservation_conflict_detected", { assetId, kind: "actor_overlap", correlationId });
        throw new Error("You already have a reservation overlapping this period");
      }

      // (Prompt 4) Snapshots do contexto no momento da reserva: binding
      // corrente = binding cuja versao e a corrente explicita do seu modelo
      // (nunca o maior id). Nullable: ativos legados sem binding ficam NULL.
      const [snapshotRows]: any = await conn.execute(`
        SELECT ab.id AS binding_id, ab.model_version_id, ab.space_id,
               a.name AS asset_name, s.inventory_code AS space_code
        FROM asset_bindings ab
        INNER JOIN model_versions v ON v.id = ab.model_version_id
        INNER JOIN models m ON m.id = v.model_id AND m.current_version_id = v.id
        INNER JOIN assets a ON a.id = ab.asset_id
        LEFT JOIN spaces s ON s.id = ab.space_id
        WHERE ab.asset_id = :assetId
        LIMIT 1
      `, { assetId });

      let snap = snapshotRows[0] ?? null;

      // (Prompt 5B) Ativos não modelados não têm binding: o snapshot vem da
      // projeção de localização corrente (nome + espaço), preservando o mesmo
      // contrato nullable das colunas de booking.
      if (!snap && lifecycleRows.length && lifecycleRows[0].source === 'graph') {
        const [graphSnapRows]: any = await conn.execute(`
          SELECT a.name AS asset_name, ala.space_id, s.inventory_code AS space_code
          FROM assets a
          LEFT JOIN asset_location_assignments ala ON ala.asset_id = a.id AND ala.valid_to IS NULL
          LEFT JOIN spaces s ON s.id = ala.space_id
          WHERE a.id = :assetId
          LIMIT 1
        `, { assetId });
        const g = graphSnapRows[0];
        if (g) {
          snap = { binding_id: null, model_version_id: null, asset_name: g.asset_name, space_id: g.space_id, space_code: g.space_code };
        }
      }

      // 3️⃣ Insert pending reservation (mesma transação — commit liberta o lock)
      const [result]: any = await conn.execute(`
        INSERT INTO res_reservations (
          asset_id,
          actor_id,
          start_time,
          end_time,
          status,
          asset_binding_id_at_booking,
          model_version_id_at_booking,
          asset_name_snapshot,
          space_id_at_booking,
          space_code_snapshot
        )
        VALUES (:assetId, :actorId, :start, :end, 'pending',
                :bindingId, :versionId, :assetName, :spaceId, :spaceCode)
      `, {
        assetId,
        actorId,
        start,
        end,
        bindingId: snap?.binding_id ?? null,
        versionId: snap?.model_version_id ?? null,
        assetName: snap?.asset_name ?? null,
        spaceId: snap?.space_id ?? null,
        spaceCode: snap?.space_code ?? null
      });

      logConcurrencyEvent("reservation_created", { assetId, reservationId: result.insertId, correlationId });
      return result.insertId;
    }), correlationId);
  }

  /**
   * PONTO DE EXTENSÃO FUTURO (documentado — §4.5 do Prompt 6): transição
   * pending → approved com revalidação de conflitos NA MESMA transação.
   *
   * NÃO existe fluxo de aprovação por gestor nesta etapa: esta função não é
   * exposta por nenhum endpoint, não tem botão, role nem portal, e nenhum
   * código a invoca. Quando a aprovação for implementada, deve chamar isto
   * (nunca um UPDATE solto): a ordem de locks é a mesma da criação
   * (assets → res_reservations), pelo que não introduz deadlocks novos.
   */
  async approvePendingWithinTransaction(reservationId: number): Promise<void> {
    await this.db.withTransaction(async (conn) => {
      const [resRows]: any = await conn.execute(
        "SELECT asset_id, actor_id, start_time, end_time, status FROM res_reservations WHERE id = :reservationId LIMIT 1",
        { reservationId }
      );
      if (!resRows.length) throw new Error("Reservation not found");
      const r = resRows[0];

      // lock por asset primeiro (ordem global de locks), depois revalidar
      await conn.execute(
        "SELECT id FROM assets WHERE id = :assetId LIMIT 1 FOR UPDATE",
        { assetId: r.asset_id }
      );

      const stillFree = !(await this.hasApprovedConflict(r.asset_id, r.start_time, r.end_time, conn));
      if (!stillFree) {
        logConcurrencyEvent("reservation_conflict_detected", { assetId: r.asset_id, kind: "approval_revalidation", reservationId });
        throw new Error("Asset already reserved for this period");
      }

      const [update]: any = await conn.execute(
        "UPDATE res_reservations SET status = 'approved' WHERE id = :reservationId AND status = 'pending'",
        { reservationId }
      );
      if (update.affectedRows === 0) {
        logConcurrencyEvent("reservation_transition_conflict", { reservationId, transition: "pending->approved" });
        throw new Error("Reservation is no longer pending");
      }
    });
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

    // compare-and-set: só transita se AINDA estiver approved e sem check-in —
    // um check-in concorrente (ou o no_show lazy) faz o perdedor falhar aqui
    const [update]: any = await this.db.connection.execute(`
      UPDATE res_reservations
      SET status = 'in_use',
          checkin_time = NOW()
      WHERE id = :id
        AND status = 'approved'
        AND checkin_time IS NULL
    `, { id: reservation.id });

    if (update.affectedRows === 0) {
      logConcurrencyEvent("reservation_transition_conflict", { reservationId, transition: "approved->in_use" });
      throw new Error(
        "Check-in not allowed: outside allowed time window or no approved reservation"
      );
    }

    return {
      message: 'Check-in successful',
      reservationId: reservation.id
    };
  }


  async checkOut(reservationId: number, actorId: string) {
    await this.markExpiredReservationsAsNoShow();
    await this.db.checkConnection();

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

    // compare-and-set: dois checkouts simultâneos ⇒ exatamente um vence;
    // o outro recebe o MESMO erro que receberia em execução sequencial.
    // overdue lazy vs checkout: ambas as origens são aceites na condição.
    const [update]: any = await this.db.connection.execute(`
      UPDATE res_reservations
      SET status = 'completed'
      WHERE id = :reservationId
        AND status IN ('in_use','overdue')
    `, { reservationId });

    if (update.affectedRows === 0) {
      logConcurrencyEvent("reservation_transition_conflict", { reservationId, transition: "in_use/overdue->completed" });
      throw new Error("No active reservation to checkout");
    }

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

    // compare-and-set: cancelar vs check-in simultâneos ⇒ um vencedor;
    // se entretanto passou a in_use/completed, o UPDATE não encontra o estado
    // esperado e o cancelamento falha com o erro sequencial equivalente
    const [update]: any = await this.db.connection.execute(`
      UPDATE res_reservations
      SET status = 'cancelled'
      WHERE id = :id
        AND status IN ('pending','approved')
    `, { id: reservationId });

    if (update.affectedRows === 0) {
      logConcurrencyEvent("reservation_transition_conflict", { reservationId, transition: "pending/approved->cancelled" });
      throw new Error("Reservation cannot be cancelled");
    }

    return { message: "Reservation cancelled" };
  }

  /* -------------------------------------
      AUTO STATUS UPDATES (lazy, corridos
      no início de cada operação)
  ------------------------------------- */

  async markExpiredReservationsAsNoShow() {
    await this.db.checkConnection();

    // approved sem check-in até 10 min depois do início → no_show
    // (UPDATE condicionado ao estado — CAS por natureza, seguro em concorrência)
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
