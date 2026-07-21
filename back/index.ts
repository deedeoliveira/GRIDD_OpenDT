import "dotenv/config";
import express from 'express';
import cors from 'cors';

const app = express();
const port = process.env.PORT || 3000;

import sensorRoutes from "./routes/sensor.ts";
import cdnRoutes from "./routes/cdn.ts";
import modelRoutes from "./routes/model.ts";
//Andressa
import reservationRoutes from "./routes/reservation.ts";
import assetRoutes from "./routes/asset.ts";
import spaceRoutes from "./routes/space.ts";
// (Prompt 5B) sincronização/reconciliação semântica — rotas administrativas
import semanticRoutes from "./routes/semantic.ts";
import institutionalRoutes from "./routes/institutional.ts";
import modelRequirementsRoutes from "./routes/modelRequirements.ts";
import modelIntakeRoutes from "./routes/modelIntake.ts";
import semanticValidationRoutes from "./routes/semanticValidation.ts";

app.use(cors());
app.use(express.json());

app.use('/api/sensor', sensorRoutes);
app.use('/api/cdn', cdnRoutes);
app.use('/api/model', modelRoutes);
//Andressa
app.use('/api/reservation', reservationRoutes);
app.use("/api/asset", assetRoutes);
app.use("/api/space", spaceRoutes);
app.use("/api/semantic", semanticRoutes);
app.use("/api/institutional", institutionalRoutes);
app.use("/api/model-requirements", modelRequirementsRoutes);
app.use("/api/model-intake", modelIntakeRoutes);
app.use("/api/semantic-validation", semanticValidationRoutes);

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
