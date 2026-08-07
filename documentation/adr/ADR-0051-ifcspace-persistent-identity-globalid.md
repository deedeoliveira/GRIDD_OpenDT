# ADR-0051 — IfcSpace persistent identity by IFC GlobalId

## Status

Accepted — **superseded in part by [ADR-0052](./ADR-0052-ifc4x3-space-semantics.md).**

> **Supersession (ADR-0052).** The GlobalId identity authority defined here
> (`linked_model_id + exact case-sensitive IfcSpace.GlobalId`) is **retained unchanged**.
> The parts of this ADR that treat `Pset_SpaceCommon.Reference` as transitional
> administrative metadata, that describe the `uq_spaces_scope_code` index as a
> *Reference*-uniqueness constraint, and that describe locking/compensation as protecting a
> "Reference" projection are **superseded**: the institutional inventory code now comes from
> `IfcSpace.Name` (→ `spaces.inventory_code`), the human label from `IfcSpace.LongName`
> (→ `spaces.long_name`), and `Pset_SpaceCommon.Reference` is **ignored** by the entire
> IFC4x3 runtime. The space-as-asset model and the `assets.space_id` column are likewise
> removed by ADR-0052. The Reference-era text below is preserved as historical audit
> material — read it together with ADR-0052, which is authoritative for current behaviour.

Refines the space-identity scope of
[ADR-0005](./ADR-0005-space-uniqueness-scope.md) /
[2026-07-16_space_identity.sql](../../database/migrations/2026-07-16_space_identity.sql),
which established `linked_model_id + Pset_SpaceCommon.Reference` as the persistent
identity key. This ADR changes the *approved target* identity key to
`linked_model_id + IfcSpace.GlobalId`.

**Rollout status:**
- **Stage 0A — additive schema foundation: applied.** The
  development/demo database `digital_twin` has the canonical column
  `spaces.ifc_global_id CHAR(22) ascii_bin NULL`, the enforced CHECK
  `chk_spaces_ifc_global_id_format`, the unique index
  `uq_spaces_linked_model_ifc_global_id`, and all existing spaces backfilled.
- **Stage 0B — runtime identity authority switched to GlobalId: implemented in
  code (this change).** Persistent-space lookup, creation, activation-time
  continuity and the model-intake preview now resolve identity by
  `linked_model_id + IfcSpace.GlobalId`. **Reference is still transitionally
  required** by the current IDS/schema and is stored as current administrative
  metadata and version snapshots — it no longer identifies the persistent space.
  The legacy Reference unique index `uq_spaces_scope_code` remains active as a
  transitional constraint.

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

## Stage 0B — runtime identity switch (implemented)

Runtime authority is now `linked_model_id + IfcSpace.GlobalId` (byte-exact,
case-sensitive), enforced in `back/services/spaceIdentityService.ts`,
`back/utils/spaceDatabase.ts`, `back/modelIntake/modelIntakeService.ts` and
`back/utils/modelIntakeDatabase.ts`.

**Runtime-safety corrections (reviewed):**

- **Lossless duplicate-GlobalId detection.** `inventoryData` is keyed by GlobalId
  and therefore collapses duplicates before any JavaScript sees them —
  `Object.keys` can never detect a duplicate exact GlobalId. The Python extraction
  now also emits an ordered, lossless `spaceOccurrences` list (one entry per
  IfcSpace entity; the extraction copies all property sets and **names none** —
  interpreting the identity Reference stays in the Node identity/model-intake
  layer). `deriveSpaceOccurrences` uses it, `groupDuplicateGlobalIds` detects the
  duplicate, and both the preview (`duplicate_candidate_globalid`) and
  `persistSpaceIdentities` (`DuplicateSpaceGlobalIdError`) block **before any
  persistent write**. Case-different GlobalIds stay distinct.
- **Every candidate is visible in the preview.** The preview no longer silently
  skips a Reference-less IfcSpace; each occurrence is emitted with a stable code,
  in precedence order `invalid_globalid` → `duplicate_candidate_globalid` →
  `missing_reference` → schema/integrity → `existing`/`new`/
  `transitional_reference_collision`. Reference remains transitionally required.
- **Preview applies the exact Stage 0A precondition.** Before its GlobalId lookups
  the preview runs `checkCanonicalPreconditionForScope`, which uses the SAME shared
  exact inspection as the write path (`utils/spaceCanonicalSchema.ts`) and returns
  controlled codes (`canonical_schema_missing` / `canonical_inconsistency`) — never
  raw SQL/driver text or a stack trace, never an auto-migration, never a Reference
  fallback.
- **Atomic binding/canonical equality.** `createBinding` is an `INSERT … SELECT
  FROM spaces` that takes `ifc_guid` from the canonical `spaces.ifc_global_id` and
  inserts only when the supplied GlobalId byte-matches for that space id; zero rows
  → typed `canonical_inconsistency`, never an insert-then-repair. The existing
  entity/space-version duplicate handling is preserved.
- **Race-safe & failure-safe Reference updates.** A concurrent
  `uq_spaces_scope_code` duplicate raised by `updateCurrentReference` is translated
  to `TransitionalReferenceCollisionError` (raw `ER_DUP_ENTRY` never leaked;
  unrelated duplicates rethrown; no binding after the collision). A Reference
  change on a **reused** space is journalled and **restored by the upload
  compensation** if the operation later fails — deleting orphan spaces does not undo
  an UPDATE to a pre-existing row; the restore is conditional on the value we
  applied still being current, so a newer concurrent change is never clobbered.
  `spaces.id`/`space_uuid`/`ifc_global_id` are never modified.

**Second review round corrections:**

- **Both extraction paths emit lossless occurrences; mandatory for writes.** The
  ordinary upload path (Flask `main.py` inventory endpoint → `fetchInventory` →
  `preprocessService`) now emits and propagates `spaceOccurrences`, exactly like the
  controlled CLI extractor — so GlobalId uniqueness is provable on both paths. For
  write-authoritative intake the lossless contract is **mandatory**: if it is absent,
  `preflightSpaceOccurrences` blocks with the operational code
  `lossless_space_occurrences_missing` and **no** entity/space/binding/asset is
  written; the GlobalId-collapsed inventory is never trusted as duplicate-safety
  evidence. Only the display-only preview may fall back (non-authoritative).
- **Pure GlobalId preflight runs before entity persistence.** `modelUploadService`
  runs `preflightSpaceOccurrences` immediately after extraction + requirements
  validation and **before `saveInventorySnapshot`**, validating the lossless
  contract, malformed GlobalIds and duplicate exact GlobalIds. A duplicate therefore
  produces **no `INSERT INTO entities`** (proved by an upload-flow test). The same
  checks remain inside `persistSpaceIdentities` as defence in depth, but persistence
  is no longer the first detector.
- **Corrected preview precedence.** A candidate-local error is reported even when the
  Stage 0A schema is absent: per candidate the order is `invalid_globalid` >
  `duplicate_candidate_globalid` > `missing_reference` >
  `canonical_schema_missing`/`canonical_inconsistency` > `existing`/`new`/
  `transitional_reference_collision`. The schema failure still **gates** the DB
  identity lookups but never **hides** a more fundamental candidate-local error.
- **Binding validation includes the model-version/linked-model chain.** `createBinding`
  is an `INSERT … SELECT` joining `spaces → model_versions → models`, inserting only
  when the space exists, the supplied GlobalId byte-matches the canonical value, the
  model version (and its model) exist, AND `models.linked_parent_id` equals the
  space's `linked_model_id`. Zero rows → typed `canonical_inconsistency` with a
  best-effort diagnosed cause (`missing_space` / `canonical_globalid_mismatch` /
  `missing_model_version` / `linked_model_chain_mismatch`), never an insert-then-repair.
- **Reference updates and compensation are protected by a linked_model-scoped
  cooperative lock.** A MySQL advisory lock (`GET_LOCK`, name
  `oswadt:space_reference:lm:<linkedModelId>`, on a dedicated connection — never a
  process-local mutex) is held from before any Reference mutation through activation
  **and** Reference compensation, and released in `finally`. Concurrent uploads for
  **different** linked_models use distinct names and stay independent; operations on
  the **same** linked_model serialise, so the previous Reference cannot be reclaimed
  by a cooperating operation during the compensation window. Compensation is
  conditional (a zero-row restore is explained as "a newer change won", never a
  silent success); a duplicate-key/other restore failure is surfaced as an explicit
  compensation-integrity note folded into the version failure reason.
- **Truthful test boundary.** A REAL Python/IfcOpenShell fixture with two IfcSpace
  entities sharing one exact GlobalId proves lossless extraction and pre-persistence
  blocking (not a hand-built array). The real `uq_spaces_scope_code` UPDATE race is
  exercised through the **actual service catch** (`persistSpaceIdentities`), not a
  manual `classifyDuplicateKey`. The binding chain and the linked_model lock
  (independence, serialization, cleanup, conditional restore) are proved on real
  MySQL by the disposable-schema self-test; the full activation orchestration remains
  covered by the fake upload-flow suites.

**Third review round corrections:**

- **The lossless contract is mandatory at EVERY write boundary.**
  `persistSpaceIdentities` no longer declares occurrences optional and never falls
  back to the GlobalId-collapsed candidates. A SHARED pure validator
  (`validateLosslessOccurrenceContract`) is applied by BOTH the orchestration
  preflight and `persistSpaceIdentities`, rejecting: missing/undefined/non-array
  occurrences (`lossless_space_occurrences_missing`); an empty list while the
  inventory has spaces; an occurrence set that does not EXACTLY reconcile with the
  candidate GlobalId set (omitted or extra); and missing/duplicated occurrence entity
  ids — all as `lossless_space_occurrences_inconsistent`, after the invalid- and
  duplicate-GlobalId checks. No entity/space/binding/asset/Reference write occurs when
  the contract is absent or inconsistent.
- **Preview precedence runs before ANY database access.** `buildSpacePreviewEntries`
  derives every candidate's local facts (valid GlobalId, duplicate, Reference present)
  with no DB access, and fetches the canonical precondition **lazily and at most once**
  — only when some candidate actually needs identity resolution. An invalid-only /
  duplicate-only / Reference-less-only set runs ZERO schema queries.
  `checkCanonicalPreconditionForScope` performs `checkConnection` INSIDE its controlled
  try, so a connection/driver failure returns a stable code
  (`canonical_schema_missing`), never raw SQL or a stack trace; a mixed set keeps
  candidate-local codes while valid candidates receive the controlled database code.
- **Each IFC occurrence has a distinct preview identity.** `PreviewSpace.ifcEntityId`
  exposes the IFC entity occurrence id; candidate/manifestation URIs incorporate it, so
  two occurrences sharing one GlobalId get DISTINCT URIs. entityId is never a persistent
  identity source. Storey is carried PER OCCURRENCE (the lossless list gained
  `storeyName`, derived per IfcSpace entity), so duplicate-GlobalId occurrences keep
  their own storey.
- **The advisory lock is scoped to the ACTUAL database.** The lock name is
  `oswadt:space_ref:<hash(SELECT DATABASE())>:lm:<linkedModelId>` (a short stable hash
  of the exact selected database, within MySQL's 64-char limit). A null/empty selected
  database is rejected. Same schema + same linked_model serialises; same schema +
  different linked_models are independent; DIFFERENT schemas with the same
  linked_model id are independent — so the disposable self-test can never block a
  `digital_twin` upload merely because both contain the same numeric id.
- **Explicit lock acquisition/release semantics.** `withNamedLock`: GET_LOCK=1 required;
  =0 → `lock_timeout`; NULL/error → `lock_error` (distinct). RELEASE_LOCK=1 required;
  0/NULL/throw (or a failing connection close) → the dedicated connection is DESTROYED
  so the server frees the session lock (never returned to the pool holding it). A
  callback error is always preserved; a release failure never hides it
  (`lockReleaseFailed` flag). Callback success + release failure →
  `lock_release_failed`. In `handleModelUpload`, `activationSucceeded` is set INSIDE the
  lock callback: a release/cleanup failure AFTER a committed activation surfaces an
  operational warning and does NOT enter business compensation (never rolls back a
  committed activation or assumes a Reference restore that did not run). Non-Error
  throwables are normalized before compensation metadata is attached.
- **Reference restore is a FULL-projection compare-and-swap.** The compensation journal
  records the complete applied projection (raw `inventory_code`,
  `inventory_code_normalized`, `name`); `restoreCurrentReference` reverts a row ONLY
  when all three still match exactly (NULL-safe on name). A newer change to the raw
  Reference or the Name — even keeping the same normalized Reference — is never
  overwritten. Zero-row restores are surfaced in the structured compensation report;
  a restore error is folded into the version failure reason. `spaces.id`/`space_uuid`/
  `ifc_global_id` are never touched.
- **Faithful two-connection race + deterministic lock barriers.** The real UPDATE race
  now uses a genuine two-connection barrier via a test-only hook fired AFTER the real
  pre-check SELECT and BEFORE the real UPDATE, while a SECOND real connection assigns
  the Reference — the actual service catch then translates the real
  `uq_spaces_scope_code`. Lock tests use deterministic entered/release barriers, and a
  combined test proves that while operation A holds the lock through its compensation
  window, cooperating operation B cannot claim A's previous Reference and only proceeds
  after A restores it and releases — then observes the restored collision.
- **Durability limitation (honest).** The compensation journal is in-memory for the
  duration of a single `handleModelUpload` call. It is held under the linked_model lock
  through activation and compensation, but it is NOT a durable/transactional log: a
  hard process crash between a Reference change and its compensation would leave the
  projection changed until the next authoritative upload reconciles the scope. The
  identity authority (spaces.id/space_uuid/ifc_global_id) is never at risk; only the
  administrative Reference projection is.

**Fourth review round corrections:**

- **Named-lock acquisition query errors have an UNKNOWN outcome and DESTROY the
  session.** A GET_LOCK query that throws (transport/query failure) may have executed on
  the server before the response was lost, so the acquisition state is unknown:
  `withNamedLock` no longer returns that connection to the pool. It DESTROYS the
  dedicated connection and raises `ConcurrencyError('lock_error')` (distinct from
  `lock_timeout`), preserving a SANITIZED cause (`{message, code, errno}` only — never
  the raw driver error, so no connection secrets). A NULL GET_LOCK result is classified
  the same way (unknown → destroy). A GET_LOCK=0 timeout holds nothing, so the
  connection is RETURNED to the pool; if that `release()` itself fails the connection is
  destroyed, with `lock_timeout` kept as the primary result and the cleanup failure
  merely reported. No callback runs on any failed acquisition path.
- **The lock namespace is derived ON the lock-holding connection.** `withNamedLock`
  accepts a lock-name FACTORY that receives the dedicated connection; `withReferenceLock`
  passes `referenceLockNameFactory(linkedModelId)`, which runs `SELECT DATABASE()` on
  that same connection, rejects a null/empty database, and builds the database-scoped
  name from the ACTUAL selected schema. The schema that scopes the lock and the session
  that holds GET_LOCK are therefore guaranteed to be the same connection — never derived
  from `DB_NAME` or a different pool connection.
- **Callback and release errors are preserved SEPARATELY.** The callback error is always
  the primary thrown error and is NEVER replaced by a release or cleanup error. A
  non-Error throwable (string/number/null/object) is normalized to a stable `Error`
  (original kept as `cause`) so metadata is always attachable. A simultaneous release
  failure attaches structured metadata (`lockReleaseFailed=true`, `lockReleaseErrorCode`,
  a sanitized `lockReleaseMessage`) rather than overriding the callback error. RELEASE_LOCK
  throw / 0 / NULL, or a failing `release()` after a confirmed RELEASE_LOCK, all become
  `ConcurrencyError('lock_release_failed')` (with the connection destroyed) when the
  callback succeeded; a destroy failure is itself reported (`lockConnectionDestroyFailed`),
  never silently ignored.
- **Reference restoration is BYTE-EXACT, independent of the table collation.**
  `restoreCurrentReference` compares the complete applied projection with explicit
  `BINARY` (`BINARY inventory_code = BINARY :appliedInventoryCode`, likewise for the
  normalized code, and `BINARY name <=> BINARY :appliedName` for the NULL-safe name). So
  a CASE-only or ACCENT-only newer change — which the case-/accent-insensitive
  `utf8mb4_0900_ai_ci` collation would treat as equal — no longer permits the row to be
  overwritten. `spaces.id`/`space_uuid`/`ifc_global_id` remain untouched.
- **The lossless runtime contract validates element SHAPE and positive IFC entity ids.**
  Because `occurrences` is accepted as `unknown`, the shared validator first checks each
  element's runtime shape BEFORE dereferencing it: a non-null object; an `entityId` that
  is a positive safe integer (never null/NaN/Infinity/0/negative/fractional/numeric
  string); optional `name`/`longName`/`storeyName` as string|null|undefined; optional
  `psets` as object|null|undefined. Malformed shapes yield
  `lossless_space_occurrences_inconsistent` with a stable `reason`
  (`malformed_occurrence` / `missing_entity_id` / `invalid_entity_id`), never a
  `TypeError`. The GlobalId itself is passed (whatever its runtime type) to the shared
  GlobalId validator, so a null/number/malformed GlobalId stays a blocking
  `InvalidSpaceGlobalIdError`. This pure contract validation runs at the START of
  `persistSpaceIdentities`, BEFORE any schema/database access, so a direct call with
  malformed occurrences returns the contract error even when the database is unavailable.
  The captured error in the persistence catch is likewise normalized before compensation
  metadata (`createdSpaceIds`/`referenceUpdates`) is attached, so a strict-mode property
  assignment on a non-Error throwable can never manufacture a `TypeError` that hides the
  real failure — and the prior Reference stays available to compensation.
- **The ordinary Flask test exercises endpoint-used code.** The Flask
  `/api/model/inventory/<modelId>` endpoint builds its body via the single pure function
  `ifcopenshell_utils.build_inventory_payload(file_path)`; the test invokes THAT function
  over the real duplicate fixture (not a hand-assembled reconstruction, not a
  regex/static source check) and proves `data` + `spaceOccurrences`, two occurrences for
  the duplicate GlobalId collapsed to one `data` key, per-occurrence `entityId`/
  `storeyName`, no interpreted Reference field, and controlled/ordinary equivalence.
- **The two-schema lock test uses two REAL selected schemas.** A disposable-MySQL
  self-test creates a SECOND schema and two real `MySQLDatabase` instances genuinely
  selected on schema A and schema B, then drives the real `referenceLockNameFactory` on
  each — proving the same `linked_model` id does not contend across the two schemas and
  DOES contend within one schema. It is not two arbitrary schema-name strings passed to
  `referenceLockName` while both connections sit on the same schema. Both disposable
  schemas are dropped and every pool/connection closed, with any cleanup failure fatal.

The base rules:

- **Lookup / creation.** Persistent spaces are resolved by
  `findByScopeAndGlobalId` (BINARY on both sides); a matched space keeps its
  `spaces.id` and `space_uuid` and its historical bindings; a new GlobalId creates
  a new row that receives `ifc_global_id`. `inventory_code_normalized` is never the
  identity key.
- **Full GlobalId validity is checked before writes.** A single shared
  application-level validator (`back/utils/ifcGlobalId.ts`, `^[0-9A-Za-z_$]{22}$`,
  ASCII-only, case-preserving, **no trimming**, no Unicode lookalikes, no Reference
  fallback) is the first line of validation in model-intake preflight, duplicate
  candidate grouping, preview classification, persistent identity resolution,
  persistent-space creation and binding creation. The Stage 0A database `CHECK`
  remains the final defence in depth. Every invalid form (null, undefined, empty,
  whitespace-only, padded-but-otherwise-valid, wrong length, disallowed character)
  is classified `invalid` with the machine code `invalid_globalid` and produces
  **zero** space/binding/metadata writes.
- **Same GlobalId + changed Reference** = the same persistent space; only the
  current administrative Reference projection (`inventory_code[_normalized]`,
  `name`) is updated, never the historical binding snapshots (§6). Before that
  update, the candidate Reference is checked against `uq_spaces_scope_code`: if it
  belongs to a **different** persistent space the update is **blocked** with a typed
  `TransitionalReferenceCollisionError` (preview `transitional_reference_collision`)
  and no `UPDATE` is issued; if it is unused, or already this space's, the change is
  allowed (§2 A/B/C).
- **Different GlobalId + same Reference** = a different identity. Because the
  legacy `uq_spaces_scope_code` is still active, this is **blocked** with a typed
  `TransitionalReferenceCollisionError` (and the `transitional_reference_collision`
  preview status) — detected deterministically before any write, never resolved by
  a Reference fallback and never a raw duplicate-key leak (§3/§7).
- **Schema precondition** (`assertCanonicalSpaceSchema`) and scope integrity
  (`findScopeCanonicalInconsistencies`) fail with a precise operational error when
  the Stage 0A column/index is absent, an existing space has a NULL canonical
  GlobalId, or a binding disagrees with its space's canonical value — never a silent
  migration or Reference fallback (§4). The structural-capability result is cached
  **keyed by the actual selected database** (`SELECT DATABASE()`): a success for one
  schema never authorizes another, a null/empty selected schema is rejected,
  failures are not cached (recovery after migration/reset works), and the cache
  never suppresses the per-operation canonical-inconsistency check (§3).
- **Duplicate exact GlobalId** in one candidate version is blocking before writes
  (machine code `duplicate_candidate_globalid`); case-different GlobalIds are
  distinct (§8).
- **Duplicate-key translation is structured, not prose-based** (§5). mysql2
  duplicate-key errors are classified by `code`/`errno`/`sqlState` plus the index
  name MySQL embeds (`back/utils/mysqlDuplicateKey.ts`): only
  `uq_spaces_linked_model_ifc_global_id` is a canonical-identity race, only
  `uq_spaces_scope_code` is a transitional Reference collision, and any **other**
  unique conflict is rethrown as an unrelated persistence error — never misread as
  either, never a Reference fallback.
- **Concurrency** (§6/§12): the unique index is the final authority; a duplicate-key
  on the canonical index re-resolves to the concurrently-created identity and the
  re-resolved row is **verified** (same `linked_model_id`, byte-equal
  `ifc_global_id`, non-null `id`/`space_uuid`) before reuse; if its Reference differs
  from the current candidate the same transitional collision rules apply (another
  space's Reference is never silently overwritten). The upload compensation removes
  any spaces/bindings created by a failed operation.
- **Dependent relations preserved.** Because `spaces.id`/`space_uuid` are stable,
  `assets.space_id`, `asset_bindings.space_id`, `asset_location_assignments.space_id`,
  `res_reservations.space_id_at_booking`, management scopes and RDF persistent UUIDs
  are unaffected. Space reservability is unchanged; no reservation_zone concept is
  introduced.

## Later stages (NOT implemented)

These are approved direction, **not yet done**:

- make `Name` and `LongName` blocking requirements;
- remove `Pset_SpaceCommon.Reference` (and `IDS-SPACE-REFERENCE`) as an
  acceptance gate, replacing it with Name/LongName requirements;
- relax/remove the legacy Reference uniqueness key (`uq_spaces_scope_code`) and
  Reference NOT NULL columns — which is what will lift the transitional
  different-GlobalId-same-Reference block;
- update IDS / RDF mapping / SHACL artifacts;
- enforce `ifc_global_id NOT NULL`.

Stage 0B does **not** change Python extraction, IDS artifacts, RDF mapping
profiles, SHACL shapes, reservation routes/services, policies, space
reservability, IfcSpatialZone logic or Fuseki data.

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

The Stage 0B **runtime** behaviour is additionally verified on its own disposable,
throwaway MySQL schema by `back/scripts/spaceGlobalIdRuntimeSelfTest.ts`, which
repoints the singleton `SpaceDatabase` at the disposable schema before importing it
(so `digital_twin` is never selected; `DB_NAME` is restored in `finally`) and
exercises the **real** Stage 0B database functions, the **real**
`persistSpaceIdentities` service path, and **real** mysql2 error objects: a real
canonical `ER_DUP_ENTRY`/errno 1062/sqlState 23000 on
`uq_spaces_linked_model_ifc_global_id` classified `canonical_globalid` and
re-resolved to the same identity (never by Reference); a real legacy conflict on
`uq_spaces_scope_code` classified `legacy_reference`; the **service** creating a
space+binding on real MySQL; the **service** raising
`TransitionalReferenceCollisionError` for a new-GlobalId-reuses-Reference and for an
existing-GlobalId Reference-change collision (rows unchanged); a successful
Reference change that journals the prior value and a conditional restore that
reverts it; a **real `uq_spaces_scope_code` UPDATE race** translated to a
transitional collision with no partial update; atomic binding/canonical equality
(matching creates, different/case-different/nonexistent → zero rows +
`canonical_inconsistency`, historical bindings unchanged); case-different GlobalIds
distinct; invalid GlobalIds rejected before `INSERT` with the DB `CHECK` as final
defence; a pre-existing binding/canonical mismatch blocking without repair; and
compensation removing only orphan spaces.

**Honest boundary.** A truly *concurrent* canonical create race cannot be staged
deterministically in a single-process fixture, so the canonical re-resolution
*branch* of `persistSpaceIdentities` is unit-tested with the fake DB
(`spaceIdentity.test.ts` case M) while the self-test proves the real primitive it
relies on (a real canonical `ER_DUP_ENTRY` classified and re-resolved to the same
identity). The complete activation transaction (modelUploadService orchestration,
including the Reference-restore compensation) is covered by the fake upload-flow
suites (`spaceUploadFlow.test.ts`), not the integration fixture. Cleanup is fatal:
the singleton pool disconnect, disposable-connection close, schema drop and server
close are tracked separately and any failure (or an undropped schema) forces a
non-zero exit.

## Consequences

- The schema now carries the approved target identity key while the application
  continues to resolve spaces by Reference — a deliberate, reversible interim
  state that de-risks the later runtime switch.
- No IFC/IDS/RDF/SHACL/frontend/reservation/space-asset behaviour changes in
  Stage 0A.
- Space identity migration and reservation-zone work remain separate changes.
