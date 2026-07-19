# <ins>O</ins>pen <ins>S</ins>ource based <ins>W</ins>eb <ins>A</ins>pplication for <ins>D</ins>igital <ins>T</ins>wins

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

Non-modelled assets (no IFC representation) are registered through
`POST /api/asset/non-modelled` and live in the operational graph as the data
authority, with a SQL projection used for reservations — the graph service
must be running for those specific operations only (everything else works
without it). See `documentation/audit/PROMPT5B_NON_MODELLED.md`.

## Documentation

The documentation is available in the [documentation directory](./documentation/Documentation.md)].