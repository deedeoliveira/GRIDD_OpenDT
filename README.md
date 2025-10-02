# <ins>O</ins>pen <ins>S</ins>ource based <ins>W</ins>eb <ins>A</ins>pplication for <ins>D</ins>igital <ins>T</ins>wins

## Getting started

### Prerequisites
- Node.js 
- Python 3.x
- 3D model file(s) in IFC format with IfcSpace (and preferably IfcSensor when using IFC 4.x files) elements
- Sensor data in a database

### Database *(optional)*

1. If you don't have a database yet, you can use the provided SQL script (`database/create_tables.sql`) to create the necessary tables.

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
flask --app main run
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

## Documentation