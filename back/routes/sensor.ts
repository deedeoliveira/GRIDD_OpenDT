import express from 'express';
import type { Response, Request } from "express";
import db from '../utils/sensorDatabase.ts';
import { buildSuccessResponse, buildErrorResponse } from '../utils/responseHandler.ts';

const app = express();

/* Get all sensors for a given room */
app.get('/room/:roomId', (req: Request, res: Response) => {
    const roomId = req.params.roomId;

    if (!roomId) {
        return buildErrorResponse(res, 400, 'Room ID is required');
    }

    return buildErrorResponse(res, 501, 'Not implemented');
});

/* Get all sensors for a given model */
app.get('/model/:modelId', (req: Request, res: Response) => {
    const modelId = req.params.modelId;

    if (!modelId) {
        return buildErrorResponse(res, 400, 'Model ID is required');
    }

    db.getSensorsByModel(modelId)
        .then(data => buildSuccessResponse(res, 200, data))
        .catch(err => {
            return buildErrorResponse(res, 500, err.message);
        });
});

/* Get sensor data with optional modelId or sensorId filter */
app.get('/data', async (req: Request, res: Response) => {
    const modelId = req.query.modelId as string;
    const sensorId = req.query.sensorId as string;

    if (!modelId && !sensorId) {
        return buildErrorResponse(res, 400, 'Model ID or Sensor ID is required');
    }

    const binSize = Number(req.query.binSize) || 3600;
    const startTime = req.query.startTime ? new Date(req.query.startTime) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endTime = req.query.endTime ? new Date(req.query.endTime) : new Date(Date.now());

    try {
        const data = await db.getSensorsData(modelId, binSize, startTime, endTime, sensorId);

        return buildSuccessResponse(res, 200, data);
    } catch (error: any) {
        return buildErrorResponse(res, 500, error.message);
    }
});

/* List all channels */
app.get('/channel', (req: Request, res: Response) => {
    db.getChannels()
        .then(data => buildSuccessResponse(res, 200, data))
        .catch(err => {
            return buildErrorResponse(res, 500, err.message);
        });
});

/* List all */
app.get('/', async (req: Request, res: Response) => {
    try {
        const data = await db.getSensors();

        return buildSuccessResponse(res, 200, data);
    } catch (error: any) {
        return buildErrorResponse(res, 500, error.message);
    }
});

/* Get by ID */
app.get('/:id', async (req: Request, res: Response) => {
    const id = req.params.id;

    try {
        const data = await db.getSensors(id);

        return buildSuccessResponse(res, 200, data);
    } catch (error: any) {
        return buildErrorResponse(res, 500, error.message);
    }
});

/* Create */
app.post('/', async (req: Request, res: Response) => {
    try {
        const createdSensors = await db.createSensor(req.body);

        return buildSuccessResponse(res, 201, createdSensors);
    } catch (error: any) {
        return buildErrorResponse(res, 500, error.message);
    }
});

/* Update */
app.patch('/:id', async (req: Request, res: Response) => {
    const id = req.params.id;

    if (!id) return buildErrorResponse(res, 400, 'Sensor ID is required');

    const originalSensors = await db.getSensors(id);

    if (!originalSensors || originalSensors.length === 0) return buildErrorResponse(res, 404, 'Sensor not found');

    try {
        const updatedSensorsData = { ...originalSensors, ...req.body };
        const updatedSensors = await db.updateSensor(id, updatedSensorsData);

        return buildSuccessResponse(res, 200, updatedSensors);
    } catch (error: any) {
        return buildErrorResponse(res, 500, error.message);
    }
});

/* Delete */
app.delete('/:id', async (req: Request, res: Response) => {
    const id = req.params.id;

    if (!id) return buildErrorResponse(res, 400, 'Sensor ID is required');

    const originalSensors = await db.getSensors(id);

    if (!originalSensors || originalSensors.length === 0) return buildErrorResponse(res, 404, 'Sensor not found');

    try {
        await db.deleteSensor(id);

        return buildSuccessResponse(res, 200, originalSensors);
    } catch (error: any) {
        return buildErrorResponse(res, 500, error.message);
    }
});

export default app;