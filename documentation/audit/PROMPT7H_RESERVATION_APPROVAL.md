# Prompt 7H — Reservation approval

Before 7H, students created `pending` requests; `approved`, `in_use` and
`no_show` blocked any overlapping interval, while another actor's `pending`
did not. Cancellation was actor-owned. The internal approval helper rechecked
SQL but had no manager endpoint, role, scope or audit.

7H adds session-derived manager authorization, asset scopes, queue endpoints
and append-only decisions. The manager is the operational authority; evidence
remains shadow and SQL is rechecked at approval.

The submission evidence is an immutable historical snapshot. Opening a single
reservation creates or refreshes a separate manager review evidence bound to
that manager session and a bounded TTL. It never replaces the submission link,
and logout makes the review unavailable for a new decision without deleting
either historical run or graph. UTC is canonical for `DATETIME` persistence:
values are explicitly serialized and parsed as UTC, independent of the Node or
MySQL host timezone. `Europe/Lisbon` is the current local display preference;
a building-owned IANA timezone, daylight-saving display, and building setup
remain future work.
# Final correction

## Approved walkthrough record

The controlled functional walkthrough was approved: a scoped manager approved
a request; the transactional SQL conflict recheck prevented a second
overlapping approval; the shadow `not_eligible` paths were explicitly handled
without becoming authorization; and a manager cancellation before check-in
preserved its append-only audit reason and displayed it to the student. These
are synthetic local demonstration flows only.

The local reservation-approval setup also prepares `pg202405` as a second
verified synthetic student linked to `TestStudentPhD002` in the current
synthetic institutional dataset. A missing supervisor assertion for this
synthetic student is not itself an eligibility failure. Manager cancellation
is available for `pending` and `approved` requests before check-in, requires a
reason and writes an append-only decision; `in_use` and terminal requests are
refused. Evidence expiry and refresh were verified automatically and by
executor-level integration smoke; the researcher-facing expired fixture was
not exercised.
