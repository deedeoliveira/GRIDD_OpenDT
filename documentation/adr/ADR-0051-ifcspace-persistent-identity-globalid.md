# ADR-0051 — IfcSpace persistent identity by IFC GlobalId

## Status

Accepted — staged implementation in progress.

Refines the space-identity scope of
[ADR-0005](./ADR-0005-space-uniqueness-scope.md) /
[2026-07-16_space_identity.sql](../../database/migrations/2026-07-16_space_identity.sql),
which established `linked_model_id + Pset_SpaceCommon.Reference` as the persistent
identity key. This ADR changes the *approved target* identity key to
`linked_model_id + IfcSpace.GlobalId`. Stage 0A (this change) is **additive
schema only** and does not yet switch runtime authority.

## Context

The current pipeline resolves a persistent `spaces` row by
`linked_model_id + inventory_code_normalized`, where `inventory_code` is
`Pset_SpaceCommon.Reference`. A read-only audit before this change established:

- The IFC delivery contract can present valid `IfcSpace` instances whose
  `Pset_SpaceCommon.Reference` does not follow the project `R-000` convention
  (e.g. `Room 1`), or is absent. Reference is an authoring convention, not a
  stable machine identity.
- `IfcSpace.GlobalId` is always present and is the natural per-model continuity
  key; it is already captured on every `space_bindings` row as `ifc_guid` (a
  version-specific manifestation snapshot), but is **not** currently the
  persistent identity key.
- The live `digital_twin` data was audited (read-only, byte-exact/BINARY
  comparisons): **11 `spaces` rows, 17 `space_bindings`**; every `spaces.id` has
  exactly one binary-distinct GlobalId across all its bindings; every
  `linked_model_id + GlobalId` maps to exactly one `spaces.id`; no missing or
  invalid GlobalIds; no duplicate target identities; no orphan spaces or
  bindings. The dataset is entirely **CLEAN_ONE_TO_ONE**, so an unambiguous
  backfill exists that preserves every `spaces.id` and `space_uuid`.

IFC compressed GlobalIds use a **case-sensitive** base64-like alphabet
(`0-9 A-Z a-z _ $`); the database default collation `utf8mb4_0900_ai_ci` is case-
and accent-insensitive and would risk folding two distinct GlobalIds together.

## Decision

1. **Accepted target identity** for a persistent space is
   `linked_model_id + IfcSpace.GlobalId`:
   - same `linked_model_id` + byte-identical GlobalId → same persistent space;
   - a different GlobalId → a different persistent space;
   - the same GlobalId in two different `linked_model_id`s does not imply the
     same persistent space;
   - comparison is **byte-exact and case-sensitive**.

2. **Prior identity** was `linked_model_id + Pset_SpaceCommon.Reference`.
   Reference is retained as **optional administrative metadata**
   (`spaces.inventory_code` / `inventory_code_normalized` and the binding
   snapshots) and will later stop being an acceptance gate.

3. **`spaces.id` and `space_uuid` are preserved.** The migration never recreates
   rows and never rewrites historical `space_bindings`. Because the live data is
   CLEAN_ONE_TO_ONE, every existing row keeps its identity.

4. **Stage 0A is additive.** It adds a canonical GlobalId column, an exact
   case-sensitive uniqueness constraint, and a deterministic backfill. It does
   **not** change runtime lookup, persistence, extraction, IDS, RDF, SHACL, the
   frontend, space-asset behaviour or space reservability. The running
   application remains **Reference-based** until later stages.

5. **Column definition.** `spaces.ifc_global_id CHAR(22) CHARACTER SET ascii
   COLLATE ascii_bin NULL`, with a `CHECK` constraint
   (`chk_spaces_ifc_global_id_format`) accepting only NULL or exactly 22
   characters from the compressed IFC GUID alphabet. `ascii_bin` gives byte-exact
   case-sensitive comparison; the database default collation is deliberately not
   used.

6. **Uniqueness.** A single unique index
   `uq_spaces_linked_model_ifc_global_id (linked_model_id, ifc_global_id)`
   enforces the target identity. The column stays NULLable for Stage 0A (MySQL
   permits multiple NULLs), so uniqueness binds every populated value without
   forcing `NOT NULL` yet and without disturbing the legacy Reference unique key
   `uq_spaces_scope_code`, which remains in place.

7. **RDF / history are not rewritten.** Persistent `bot:Space` URIs remain keyed
   by the preserved `space_uuid`; historical manifestation graphs and their
   `project:reference` triples stay as historically correct evidence. Future
   manifestations may carry both GlobalId and optional Reference (a later stage).

8. **Migration mechanism.** Because `ALTER TABLE` implicitly commits in MySQL, the
   migration is **not** a single transaction. It is implemented as a narrowly
   scoped, **restart-safe** TypeScript executor
   (`back/scripts/migrations/spaceGlobalId.ts`, run via
   `back/scripts/runSpaceGlobalIdMigration.ts`): hard data guards run **before**
   any DDL and abort on the offending ids; each step (add column, add check,
   backfill, add index) is idempotent, so re-running from any supported partial
   state converges. A populated canonical GlobalId is never silently overwritten
   or dropped. The generic `runSqlFile.ts` is unchanged.

   - **Restart safety requires EXACT metadata verification, not name checks.**
     Each artifact is classified `ABSENT` / `EXACT` / `CONFLICTING` from
     `information_schema` (column: data type, length, charset, collation,
     nullability, no default, not generated; index: uniqueness, exact two-column
     order, no prefix, no expression, visible; CHECK: see below). A same-name but
     differently-shaped artifact is **CONFLICTING** — forward fails before any
     data change and rollback refuses to drop it; neither is silently replaced.
   - **The CHECK is validated on the exact, case-sensitive regex literal AND its
     enforcement — not just its name.** Normalisation is **quote-aware**: it
     lowercases keywords/function names, drops backticks and whitespace and strips
     the MySQL charset introducer only OUTSIDE string literals, and copies the
     literal content verbatim (decoding `\\` and `''`, treating `\'`/`'` as the
     delimiter MySQL serialises). It never globally lowercases the clause, so the
     case-sensitive alphabet `^[0-9A-Za-z_$]{22}$` is preserved — a lowercase-only
     (`a-z`), uppercase-only (`A-Z`), differently-sized (`{21}`/`{23}`/`+`/`*`) or
     otherwise weaker/stronger regex is `CONFLICTING`. The constraint must also be
     actively enforced (`information_schema.TABLE_CONSTRAINTS.ENFORCED = YES`): a
     correct clause that is `NOT ENFORCED` is `CONFLICTING`.
   - **The backfill DML is atomic even though the surrounding DDL is not.** A
     complete conflict preflight (drift / missing derivation / conflicting non-null
     value) runs before the first write; the write is a single set-based
     `UPDATE … JOIN` inside an explicit transaction with a post-update NULL
     re-check, so it is all-or-nothing. The column/CHECK may already exist after a
     failed run (DDL commits), but the backfill itself is never partial.
   - **The legacy Reference index is inspected exactly and required.** Because the
     runtime is still Reference-based, `uq_spaces_scope_code` must be present as
     `UNIQUE(linked_model_id, inventory_code_normalized)` — classified
     ABSENT/EXACT/CONFLICTING like the other artifacts. If it is not `EXACT`,
     forward fails **before** adding the GlobalId column. Stage 0A never creates,
     repairs, drops or renames it.
   - **Final structural verification** re-confirms exact column/CHECK/index, that
     every space is populated and byte-matches its verified binding GUID, that no
     duplicate `linked_model + BINARY GlobalId` exists, that the legacy
     `uq_spaces_scope_code` remains `EXACT`, and re-runs the data guards.

9. **CLI safety contract.** The CLI (`runSpaceGlobalIdMigration.ts`) never migrates
   from an implicit `.env` alone. Forward requires
   `--confirm-database <name> --maintenance-confirmed`; rollback additionally
   requires `--rollback --confirm-rollback`. Unknown arguments fail rather than
   being ignored. Before any work it asserts
   `--confirm-database === DB_NAME === SELECT DATABASE()` and rejects the system
   schemas (`mysql`, `information_schema`, `performance_schema`, `sys`); it logs
   host/port/database/direction but never the password. A migration-specific MySQL
   **advisory lock** (`oswadt:space_globalid_migration`, `GET_LOCK` timeout 0,
   released in `finally`) prevents two executors running at once — it does **not**
   block ordinary application writes.

10. **Maintenance window required.** Because Stage 0A deliberately keeps
    `ifc_global_id` NULLable, an application write (model activation / space or
    binding persistence) **after** the final verification could introduce a fresh
    NULL row. All backend processes capable of such writes MUST be stopped for the
    migration; the advisory lock alone does not guarantee this — hence
    `--maintenance-confirmed`.

11. **CLEAN_ONE_TO_ONE finding recorded.** The Stage 0A backfill derives each
    space's single BINARY-verified GlobalId from its bindings and refuses to
    proceed on drift, duplicate target identity, invalid/missing GUIDs, mismatched
    linked-model resolution (G7 via LEFT JOIN, detecting a missing version/model or
    NULL/mismatched `linked_parent_id`), or a conflicting prepopulated value.

## Later stages (NOT implemented by this ADR)

These are approved direction, **not yet done**:

- switch runtime lookup and persistence to GlobalId
  (`spaceIdentityService`, `modelUploadService`, model-intake preview,
  Python extraction);
- make `Name` and `LongName` blocking requirements;
- remove `Pset_SpaceCommon.Reference` (and `IDS-SPACE-REFERENCE`) as an
  acceptance gate, replacing it with Name/LongName requirements;
- relax/remove the legacy Reference uniqueness key;
- enforce `ifc_global_id NOT NULL`.

## Out of scope

- **IfcSpatialZone / reservation_zone** is explicitly outside this ADR's
  implementation scope.
- **Geometric overlap validation** between spatial zones is outside the
  application boundary; it remains an upstream BIM-authoring/coordination
  responsibility owned by the BIM delivery process and BIM Manager. This ADR
  neither implements nor claims any overlap computation.

## Rollback

The paired rollback (`applyRollback`) removes only the new unique index, the
`CHECK` constraint and the `ifc_global_id` column, in dependency order (index →
check → column). It first inspects each artifact's exact shape: an `EXACT` match
may be dropped, an `ABSENT` one is a no-op, and a **same-name artifact with an
unexpected definition is refused** (throws) and left untouched — a wrong-shaped
column, a non-unique / wrong-order index reusing the name, or a different CHECK
under the name are never dropped. It never uses CASCADE and never touches
`spaces.id`, `space_uuid`, `inventory_code`, `name`, `space_bindings` or any
foreign key or business table. It is idempotent across the supported partial
states. Rollback is intended **only before** later stages make runtime code
depend on `spaces.ifc_global_id`.

## Verification

Both directions and cases **A–T** are verified on a disposable, throwaway MySQL
schema by `back/scripts/spaceGlobalIdMigrationSelfTest.ts` (which never selects or
modifies `digital_twin`; every cleanup step is attempted independently and a
primary OR any cleanup error — including an undropped schema — forces a non-zero
exit, so a green run can never leave a disposable schema behind): A clean multi-version · B same GlobalId
across linked_models · C duplicate target identity · D GlobalId drift · E
case-sensitive identities · F missing/invalid GlobalId · G restart/partial states
· H already-applied · I conflicting prepopulated column · J rollback · K wrong
column shape · L wrong same-name index · M wrong same-name CHECK · N multi-row
conflict = zero partial updates · O G7 linked-model mismatch · P CLI confirmation
contract · Q rollback refuses wrong-shaped artifacts · R already-applied exact
definitions idempotent · S CHECK clause case-sensitivity (exact / lowercase-only /
uppercase-only / wrong-length / harmless-formatting) and enforcement (a correct
but `NOT ENFORCED` CHECK is CONFLICTING, refused by both forward and rollback) · T
exact legacy Reference-index inspection (`uq_spaces_scope_code` must be present as
UNIQUE(linked_model_id, inventory_code_normalized); a missing, non-unique or
reversed-column same-name index fails forward **before** any Stage 0A DDL, and the
migration never creates, repairs, drops or renames it). CLI argument parsing and
the case-insensitive system-schema guard are unit-tested in
`back/tests/spaces/spaceGlobalIdMigrationCli.test.ts`, the quote-aware CHECK
normaliser/classifier in `back/tests/spaces/spaceGlobalIdCheckNormalization.test.ts`,
and the fatal cleanup-outcome classifier in
`back/tests/spaces/spaceGlobalIdSelfTestOutcome.test.ts`. Before applying to the
active development/demo database, **stop the backend**, create a fresh backup and
review the plan; the archived post-presentation backup/tag baseline must remain
untouched.

## Consequences

- The schema now carries the approved target identity key while the application
  continues to resolve spaces by Reference — a deliberate, reversible interim
  state that de-risks the later runtime switch.
- No IFC/IDS/RDF/SHACL/frontend/reservation/space-asset behaviour changes in
  Stage 0A.
- Space identity migration and reservation-zone work remain separate changes.
