# ADR-0052 — IFC4x3 space semantics: Name as inventory code, LongName as label, Reference removed, space is not an asset

- Status: Accepted
- Date: 2026-08-04
- Supersedes (in part): ADR-0051 (IfcSpace persistent identity via GlobalId) — the
  GlobalId identity authority is **retained unchanged**; the parts of ADR-0051 that
  describe `Pset_SpaceCommon.Reference` as transitional runtime metadata and the
  legacy `uq_spaces_scope_code` Reference-uniqueness constraint are **superseded**.
- Related: ADR-0005 (space uniqueness scope), ADR-0006 (spatial authority),
  ADR-0009 (strict spatial preflight), ADR-0039 (controlled model intake).

## Context

Stage 0B (ADR-0051) established the persistent identity authority for an `IfcSpace`
as `linked_model_id + exact case-sensitive IfcSpace.GlobalId`, while continuing to
read the institutional inventory code from `Pset_SpaceCommon.Reference` as
"transitional administrative metadata". A live experiment on the synthetic Stage 0B
building (model 9, versions 21→22) confirmed the identity behaves correctly, but also
confirmed that the Reference projection is a semantic dead-end:

- The UMinho institutional inventory code is authored in `IfcSpace.Name`, not in a
  custom property set. Sourcing it from `Pset_SpaceCommon.Reference` requires every
  IFC author to duplicate the code into a non-standard pset.
- `IfcSpace.LongName` is the natural human-readable description; the application stored
  it in an **ambiguous display column** `spaces.name` that was populated from
  `candidate.longName ?? candidate.name ?? null` — i.e. it normally contained
  `IfcSpace.LongName` and only fell back to `IfcSpace.Name` when LongName was absent. It
  never reliably held a single, well-defined value.
- Treating each `IfcSpace` as an `asset` (`asset_type='space'`), creating asset
  bindings for spaces, and making spaces directly reservable conflated a persistent
  spatial *context* with a reservable *resource*.

The application profile is also being fixed to **IFC4x3-only**; IFC4 is no longer the
operational target schema.

## Decision

### A. IFC version — IFC4x3-only

The operational application profile accepts **only** the IFC4x3 family and rejects
IFC2X3 and IFC4 with an explicit unsupported-schema result.

The installed IfcOpenShell (0.8.x) can **parse** exactly these four IFC4x3 schema
identifiers: `IFC4X3`, `IFC4X3_ADD1`, `IFC4X3_ADD2`, `IFC4X3_TC1`. Pre-release
`IFC4X3_RC<number>` forms are **not** accepted — IfcOpenShell 0.8 raises `SchemaError`
when opening them, so admitting them would advertise a variant the toolchain cannot
process. The application rule is a **precise allowlist**, not a prefix test:

> A file is accepted iff its declared header schema identifier, upper-cased, is exactly
> one of `IFC4X3`, `IFC4X3_ADD1`, `IFC4X3_ADD2`, `IFC4X3_TC1`. Any other identifier —
> including a pre-release `IFC4X3_RC<number>`, an invented `IFC4X3`-prefixed variant such
> as `IFC4X3_ADD3`, and notably `IFC2X3`, `IFC4`, `IFC4_ADD*` — yields an explicit
> `unsupported_ifc_schema` result. The `IFC4X3` allowlist is tested
> **before** any bare `IFC4` branch, because `"IFC4X3".startsWith("IFC4")` is true. The
> identical policy is implemented in `back/utils/ifcSchemaSupport.ts` (TypeScript) and
> `back/python/ifcopenshell_utils.py` (`classify_ifc_schema`), and enforced at every
> operational entry point: controlled intake, initial/legacy upload, and the legacy
> sensor-extraction route.

### B. Persistent space identity — unchanged

The persistent identity remains `linked_model_id + exact case-sensitive
IfcSpace.GlobalId`. Preserved: exact GlobalId validation (`^[0-9A-Za-z_$]{22}$`),
linked-model scoping, case-sensitive matching, canonical uniqueness
(`uq_spaces_linked_model_ifc_global_id`), version-specific bindings. Identity is
**never** matched by Name, LongName, or Reference.

### C. Institutional inventory code — from `IfcSpace.Name`

The real UMinho inventory code comes **exclusively** from `IfcSpace.Name`, projected
into `spaces.inventory_code` (and `spaces.inventory_code_normalized` by the existing
normalization policy), unique within the `linked_model` scope
(`uq_spaces_scope_code`). `IfcSpace.Name` is institutionally required even though the
IFC schema defines it as optional: a missing or blank `Name` **blocks intake**
(`missing_space_name`).

### D. Human-readable description — from `IfcSpace.LongName`

The informational description comes from `IfcSpace.LongName`, projected into
`spaces.long_name`. `LongName` may be absent; when absent the UI may display only the
inventory code.

### E. Deprecated Reference — removed from runtime

`Pset_SpaceCommon.Reference` MUST NOT be used anywhere in the active IFC4x3 runtime:
not for identity, inventory code, display, validation, collision checks, bindings,
RDF mapping, IDS, SHACL, compensation, or compatibility fallback. There is no
Reference fallback. A file may still *contain* a Reference property — the runtime
**ignores** it rather than interpreting it.

### F. Space is not an asset

`IfcSpace` is a persistent spatial context, not an asset and not a directly
reservable resource. The application no longer creates `assets` with
`asset_type='space'`, asset bindings for spaces, or reservation resources for spaces.

**Asset location model.** The persistent `assets` row holds identity, type and
lifecycle but **no** IFC-version-specific location. Modelled equipment location is
version-specific in `asset_bindings.space_id` (the containing persistent space for that
manifestation/version); the **current** location is derived from the binding of the
current model version, and the ordered bindings are the location history. Non-modelled
/ graph assets use `asset_location_assignments` under the existing graph-authority
workflow. The legacy `assets.space_id` column (with `uq_assets_space` / `fk_assets_space`)
belonged to the removed one-space-asset-per-space model and is **dropped** by this
migration — it is never repurposed as an equipment-location projection, and no
replacement current-location column is added.

### G. IfcSpatialZone — out of scope

No `IfcSpatialZone` extraction, zone assets, zone reservations, `reservation_zone`,
zone membership, or space-to-zone aggregation is implemented here. IfcSpatialZone is
deferred to a later dedicated stage. (Note: IFC does **not** define IfcSpatialZone as
an asset; the deferral is purely a scope boundary.)

### H. Governed semantic artifacts — versioned, durable, deterministically selected

The IFC4x3 semantics are carried by three governed runtime artifacts: the IDS profile,
the IFC-to-RDF mapping, and the model structural SHACL shapes. Each is versioned as an
**immutable manifestation**:

- The original **1.0.0** manifestations (IFC4-era, `Pset_SpaceCommon.Reference` semantics)
  are retained byte-for-byte under their `.../1.0.0/...-v1.*` paths and original hashes, and
  are marked `activationAllowed: false` — kept for historical reproducibility, never loaded.
- The active **1.1.0** manifestations (IFC4x3, `IfcSpace.Name` inventory code) live under new
  `.../1.1.0/...-v1.1.*` paths with their own hashes and `activationAllowed: true`.

Active selection is by **exact key** `${familyKey}-1.1.0` (`ACTIVE_ARTIFACT_VERSION`), never a
`startsWith` prefix / array-first match, so production deterministically activates 1.1.0, the
superseded 1.0.0 is resolvable only by its own exact key, and an unknown configured key fails
closed.

**IDS applicability durability.** The IDS 1.0 XSD enumerates only `IFC4X3_ADD2` among the
IFC4x3 tokens, and IfcTester filters on the exact `schema_identifier`. No XSD-valid IDS can
therefore name all four accepted variants. The governed IDS keeps entity-based applicability
(every `IfcSpace`) and the runtime runs IfcTester with `should_filter_version=False` as an
explicit, tested contract, so `IDS-SPACE-NAME` governs `IFC4X3`, `IFC4X3_ADD1`, `IFC4X3_ADD2`
and `IFC4X3_TC1` alike — never only `IFC4X3_ADD2`.

**SHACL schema constraint.** `ModelVersionShape` pins the fully-anchored alternation
`^(IFC4X3|IFC4X3_ADD1|IFC4X3_ADD2|IFC4X3_TC1)$` (not the loose `^IFC4X3`), so an invented
`IFC4X3_*` identifier, a pre-release RC, `IFC4` or `IFC2X3` all violate — matching the runtime
allowlist layer-for-layer.

## Layered model (explicit)

| Concern | Source of truth |
| --- | --- |
| Persistent technical identity | `linked_model_id + IfcSpace.GlobalId` |
| Current institutional code | `IfcSpace.Name` → `spaces.inventory_code` (+ normalized) |
| Current informational description | `IfcSpace.LongName` → `spaces.long_name` |
| Historical manifestation | version-specific `space_bindings` snapshots |
| Modelled equipment location (per version) | `asset_bindings.space_id` → `spaces.id` |
| Current equipment location | binding of the current model version |
| Non-modelled/graph asset location | `asset_location_assignments` (graph authority) |

## Consequences

- **Breaking semantic migration.** Existing operational rows were populated under the
  old Reference semantics: `spaces.inventory_code` held the `Pset_SpaceCommon.Reference`
  value, and `spaces.name` was the ambiguous display column described above — normally
  `IfcSpace.LongName`, falling back to `IfcSpace.Name` (`longName ?? name`). The schema
  rename `spaces.name → spaces.long_name` moves that column and its data but does **not**
  semantically convert old Reference-derived inventory codes into `IfcSpace.Name` values,
  and the renamed `long_name` therefore still carries the old ambiguous value rather than
  a guaranteed LongName. Existing model data requires **re-ingestion / reset** after this
  migration; no backfill from old Reference (or old `spaces.name`) values is attempted (it
  would be unreliable and is explicitly refused).
- The `spaceIdentityService` / `spaceDatabase` concurrency and compensation machinery
  is retained but renamed to reflect that it protects a mutable **space-metadata**
  projection (`inventory_code`, `inventory_code_normalized`, `long_name`), not a
  Reference.
- The legacy Reference-uniqueness constraint `uq_spaces_scope_code` is now the
  institutional inventory-code uniqueness constraint (same columns), no longer a
  transitional Reference index.
- `assets.asset_type` loses its `'space'` member; legacy space assets, their bindings,
  reconciliation/location rows, and the reservations that pointed at them are removed
  by a controlled, auditable migration (synthetic research data only; not applied to
  `digital_twin` in this task).
- **Runtime is now migration-compatible.** The space-as-asset removal has landed:
  `assetInventoryService` no longer creates `asset_type='space'`, `persistentAssetDatabase`
  no longer exposes space-asset creation/lifecycle, the reservation domain rejects spaces
  as resources (discovery, creation, and manager approval), and equipment location is
  resolved through the current model version's `asset_bindings.space_id` → the
  GlobalId-matched persistent space (`inventory_code` / `long_name`) — never through the
  persistent `assets` row. The forward migration contracts `assets.asset_type` to
  `ENUM('equipment','tool')` **and drops the now-unused `assets.space_id` column** (with
  `uq_assets_space` / `fk_assets_space`); both are compatible with every runtime
  insert/update path.
- **The full branch is still NOT deployable until IDS/RDF/SHACL align.** The governed IDS
  artifact migration, the RDF predicate rename, the SHACL artifact migration, the
  mapping-profile version/hash update, and the operational database/Fuseki reset remain
  deferred to a separate, separately-reviewed batch. Do not deploy the branch, and do not
  apply this migration to `digital_twin`, until those layers are also aligned.

## Not decided here

Operational reset / re-ingestion of the live `digital_twin` data and Fuseki graphs is
a separate, separately-reviewed task. The governed IDS/RDF/SHACL alignment is a later,
separately-reviewed batch. IfcSpatialZone support is a later stage.
