# <ins>O</ins>pen <ins>S</ins>ource based <ins>W</ins>eb <ins>A</ins>pplication for <ins>D</ins>igital <ins>T</ins>wins

> Prompt 7C adds genuine IDS validation through IfcTester/IfcOpenShell. The
> governed public profile is a `file_executed` registry artifact: it has an
> immutable hash, version, lifecycle and SQL current pointer, but no named graph
> and is never sent to Fuseki.

> Prompt 7D adds the feature-gated `/dashboard` controlled model intake. A
> researcher selects real IFC/IDS files, reviews backend-computed hashes,
> genuine IDS/project-rule results and backend-generated RDF, then may
> explicitly create an immutable version and verified version named graph.

## Getting started

### Prerequisites
- Node.js 
- Python 3.x
- 3D model file(s) in **IFC4** — the interchange schema currently supported and tested by the project. Models must satisfy the current project information-requirement profile (see `documentation/audit/PROMPT4_ASSETS.md`): authoritative spatial models need `IfcSpace` elements with `Pset_SpaceCommon.Reference` codes; managed equipment needs an `IfcElement.Tag` starting with `EQP-`; every `IfcBuildingElementProxy` needs a valid `ObjectType` and an `EQP-` Tag. Other schemas are not automatically rejected, but only IFC4 is tested.
- Sensor data in a database

### Database *(optional)*

1. If you don't have a database yet, you can use the provided SQL script (`database/create_tables.sql`) to create the necessary tables. Then apply the migrations in `database/migrations/` (in date order):

```bash
cd back
npx tsx scripts/runSqlFile.ts ../database/migrations/<migration>.sql
```

`database/schema_snapshot_2026-07-15.sql` is historical evidence of the development schema (do not apply or regenerate it).

2. Populate the database with mock-up data using the provided JavaScript file (`database/mock-up/index.js`). You may need to modify the database connection settings in the file.

```bash
cd database/mock-up
npm install
node index.js
```

### Backend

> [!WARNING]
> There is two servers running in the backend:
> - One running on Node.js (with Express framework) for managing CRUD operations for models and sensors.
> - One running on Python (with Flask framework and IfcOpenShell library) for processing IFC files and retrieving global IDs of rooms and sensors.

#### Node.js server

1. **Set environment variables**

Create a `.env` file in the `back` directory and assign the values of the variables (see `.env.example`).

2. **Install dependencies**

```bash
cd back
npm install
```

3. (Optional) **Implement database classes**

In this project, a MySQL database is used. If you want to use another type of database, or modify the queries, you can implement you own database classes in the `back/utils` directory.

4. **Run the server**

```bash
npm run dev
```

#### Python server

1. **Set environment variables**

Create a `.env` file in the `back/python` directory and assign the values of the variables (see `.env.example`).

2. (Optional) **Set up a virtual environment**

It is recommended to use a virtual environment to manage dependencies and Python versions.

```bash
cd back/python
python -m venv <name-of-virtual-environment>
./<name-of-virtual-environment>/Scripts/activate
```

3. **Install dependencies**

```bash
cd back/python
pip install -r requirements.txt
```

4. **Run the server**

```bash
flask --app main run -p 3002
```

#### Testing the APIs

You can use the provided Bruno collection (`back/bruno_collection`) to test the APIs of the Node.js and Python servers.

### Frontend

1. **Set environment variables**

Create a `.env` file in the `front` directory and assign the values of the variables (see `.env.example`).

2. **Install dependencies**

```bash
cd front
npm install
```

3. **Run the development server**

```bash
npm run dev
```

### Semantic graph *(optional)*

The application runs fully without the graph. To start the local triplestore
(Apache Jena Fuseki 5.6.0, port 3030 — requires Java 17+):

```powershell
powershell -ExecutionPolicy Bypass -File infrastructure\graph\setup-fuseki.ps1   # once
powershell -ExecutionPolicy Bypass -File infrastructure\graph\start-fuseki.ps1
```

Then set the `GRAPH_*` variables in `back/.env` (see `back/.env.example`) and
check the connection with `npx tsx scripts/graphSmoke.ts` (from `back/`).
See `documentation/audit/PROMPT5A_GRAPH.md` for the URI strategy, named-graph
conventions and the data-authority matrix.

The governed semantic-artifact layer keeps an audited public/synthetic Turtle
subset in `semantic/artifacts`, an immutable revision registry in SQL, and one
UUID-scoped Fuseki graph per revision. Loading is local-CLI only, disabled by
default, and never runs at application startup:

```bash
cd back
npm run semantic:artifacts:validate
npm run semantic:artifacts:load-public -- --dry-run
```

Actual loading requires the registry migration, existing `GRAPH_*` settings,
and explicit `SEMANTIC_ARTIFACT_LOADING_ENABLED=true`. The institutional
ontology is a non-official draft research artefact; the governed shape set is
not SHACL execution. See
`documentation/audit/PROMPT7B1_SEMANTIC_ARTIFACTS.md` and ADR-0032/0033.

Prompt 7B2 adds a disabled-by-default, read-only institutional context layer.
Controlled SQL links connect synthetic platform actor keys to agents in the
active synthetic institutional graph; `/semantic-demo` presents memberships,
roles, supervisors and artifact provenance. This is research evidence—not
authentication, authorization, eligibility or a reservation decision. See
`documentation/audit/DEMO_INSTITUTIONAL_CONTEXT.md` and ADR-0034/0035.

Non-modelled assets (no IFC representation) are registered through
`POST /api/asset/non-modelled` and live in the operational graph as the data
authority, with a SQL projection used for reservations — the graph service
must be running for those specific operations only (everything else works
without it). See `documentation/audit/PROMPT5B_NON_MODELLED.md`.

## IDS functional demonstrator

IDS validation is disabled by default. Local technical preparation uses the
exact flags `IDS_VALIDATION_ENABLED=true`, `IDS_VALIDATION_MODE=required`,
`IDS_PROFILE_FAMILY_KEY=oswadt-ifc4-model-requirements`, and
`IDS_DEMO_MODE=true`, followed from `back/` by:

```bash
npm run ids:demo:setup
npm run ids:demo:setup -- --execute
```

The first command is a dry-run and neither command applies migrations. The
researcher only opens `http://localhost:3000/ids-demo`, chooses a synthetic
scenario and reads the separate IDS/project-rule report. The demonstrator does
not decide reservability, eligibility, authorization or approval and does not
create or alter reservations.

## Controlled model intake

The management workspace is disabled by default. After applying the Prompt 7D
migration locally, technical preparation enables the exact flags documented in
`back/.env.example`, uses `IFC_RDF_MATERIALISATION_MODE=required`, and runs:

```bash
cd back
npm run model-intake:setup
npm run model-intake:setup -- --execute
```

Setup never applies migrations, selects/uploads an IFC, creates a model
version, resets data or deletes graphs. The researcher opens
`http://localhost:3000/dashboard` and controls the file pickers. **Validate and
preview** is read-only with respect to models, identities, graphs and
reservations; **Create model version** is a separate explicit action. See
`documentation/audit/MODEL_INTAKE_WALKTHROUGH.md` and ADR-0038/0039.

This workspace deliberately starts from an already registered building/model
line and is not the final management-interface design. Future product work is
to add the building list and registration, creation of the persistent building
identity and initial logical model line, first IFC/version onboarding, and
subsequent version management from the building page.

## Documentation

The documentation is available in the [documentation directory](./documentation/Documentation.md)].

- **Consolidated architecture** (versioning, identities, location, graph/SQL
  authority, reservations, concurrency, failure recovery, future semantic
  work): [documentation/CONSOLIDATED_ARCHITECTURE.md](./documentation/CONSOLIDATED_ARCHITECTURE.md)
- Concurrency audit and transactional boundaries (Prompt 6):
  [documentation/audit/CONCURRENCY_AUDIT.md](./documentation/audit/CONCURRENCY_AUDIT.md)
- Final integration assessment: [documentation/audit/PROMPT6_INTEGRATION.md](./documentation/audit/PROMPT6_INTEGRATION.md)
- Demo walkthrough (10–15 min): [documentation/audit/DEMO_SCRIPT.md](./documentation/audit/DEMO_SCRIPT.md)
- Institutional functional demonstration:
  [documentation/audit/DEMO_INSTITUTIONAL_CONTEXT.md](./documentation/audit/DEMO_INSTITUTIONAL_CONTEXT.md)
- Architecture decision records: [documentation/adr/](./documentation/adr/) (ADR-0001…ADR-0039)
