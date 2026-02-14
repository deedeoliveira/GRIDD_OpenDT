import "dotenv/config";
import express from 'express';
import cors from 'cors';

const app = express();
const port = process.env.PORT || 3000;

import sensorRoutes from "./routes/sensor.ts";
import cdnRoutes from "./routes/cdn.ts";
import modelRoutes from "./routes/model.ts";
import reservationRoutes from "./routes/reservation.ts";

app.use(cors());
app.use(express.json());

app.use('/api/sensor', sensorRoutes);
app.use('/api/cdn', cdnRoutes);
app.use('/api/model', modelRoutes);
app.use('/api/reservation', reservationRoutes); // 👈 NOVO

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
