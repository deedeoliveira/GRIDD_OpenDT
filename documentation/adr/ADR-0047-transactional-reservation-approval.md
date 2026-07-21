# ADR-0047 — Transactional reservation approval

Manager approval locks the reservation and its asset, rechecks SQL conflicts,
changes only a pending request and appends a decision audit row in one SQL
transaction. Shadow semantic evidence is visible but never authorizes or
blocks automatically. A shadow override requires acknowledgement and reason.
