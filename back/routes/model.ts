import express from 'express';
import path from 'path';
import multer from 'multer';
import { buildErrorResponse, buildSuccessResponse } from "../utils/responseHandler.ts";
import db from '../utils/modelDatabase.ts';
import sensorDb from '../utils/sensorDatabase.ts';
import fs from 'fs';
import { SensorChannelEnum } from '../types/sensors.ts';

const app = express();

const MODELS_TEMP_ROOT_PATH = path.join(import.meta.dirname, '../cdn_resources/models/temp');
const MODELS_ROOT_PATH = path.join(import.meta.dirname, '../cdn_resources/models');

const upload = multer({ dest: MODELS_TEMP_ROOT_PATH });

app.get('/linked/', async (req, res) => {
    const linkedModels = await db.listLinkedModels();

    if (linkedModels instanceof Error) {
        return buildErrorResponse(res, 500, linkedModels.message);
    }

    return buildSuccessResponse(res, 200, linkedModels);
});

app.get('/linked/:id', async (req, res) => {
    const linkedId = req.params.id;

    if (!linkedId) {
        return buildErrorResponse(res, 400, 'Linked Model ID is required');
    }

    const linkedModel = await db.getLinkedModelMetadata(linkedId);

    if (linkedModel instanceof Error) {
        return buildErrorResponse(res, 500, linkedModel.message);
    }

    return buildSuccessResponse(res, 200, linkedModel);
});

app.get('/', async (req, res) => {
    const models = await db.listModels();

    if (models instanceof Error) {
        return buildErrorResponse(res, 500, models.message);
    }

    return buildSuccessResponse(res, 200, models);
});

app.get('/:id', async (req, res) => {
    const modelId = req.params.id;

    if (!modelId) {
        return buildErrorResponse(res, 400, 'Model ID is required');
    }
    
    const model = await db.getModelMetadata(modelId);

    if (model instanceof Error) {
        return buildErrorResponse(res, 500, model.message);
    }

    return buildSuccessResponse(res, 200, model);
});

app.get('/download/:id', async (req, res) => {
    const id = req.params.id;

    if (!id) {
        return buildErrorResponse(res, 400, 'Model ID is required');
    }

    const data = await db.downloadModel(id);

    if (data instanceof Error) {
        return buildErrorResponse(res, 500, data.message);
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename=${id}.ifc`);
    res.send(data);
});

app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file && !req.body?.fileUrl) return buildErrorResponse(res, 400, 'File or file location is required');

    if (req.fileUrl) {
        //TODO: implement upload from url
        return buildErrorResponse(res, 501, 'Upload from URL not implemented yet');
    }

    const name = req.body.name || req.file.originalname.split('.')[0];
    const linkedParentId = req.body.linkedParentId;
    const modelId = req.body.modelId;

    if (!modelId) {
        /* If modelId is not provided, create a new model */
        const model = await db.uploadModel(name, null, linkedParentId);

        if (model.id) {
            // Rename the file to its model ID and move it to the models folder
            fs.renameSync(req.file.path, path.join(MODELS_ROOT_PATH, `${model.id}.${path.extname(req.file.originalname).slice(1)}`));

            return buildSuccessResponse(res, 201, model);
        }
    } else {
        // If modelId is provided, update the existing model

        // Move the previous file to an archive folder
        if (!fs.existsSync(path.join(MODELS_ROOT_PATH, 'archive'))) {
            fs.mkdirSync(path.join(MODELS_ROOT_PATH, 'archive'));
        }

        fs.renameSync(path.join(MODELS_ROOT_PATH, `${modelId}.ifc`), path.join(MODELS_ROOT_PATH, 'archive', `${Date.now()}_${modelId}.ifc`));

        // Move the new file to the models folder
        fs.renameSync(req.file.path, path.join(MODELS_ROOT_PATH, `${modelId}.${path.extname(req.file.originalname).slice(1)}`));

        return buildSuccessResponse(res, 200, { id: modelId, message: `Model ${modelId} updated successfully` });
    }

});

/**
 * Process a model by extracting sensor guid and space guid where the sensor is located.
 * For each sensor, create a new sensor in the database with all channels enabled.
 * If a sensor with the same guid and model_id already exists, it is not created again.
 * Returns the list of created sensors.
 * @param id Model ID
 * @return List of created sensors
 */
app.get('/process/:id', async (req, res) => {
    const modelId = req.params.id;

    const resp = await fetch(`${process.env.IFCOPENSHELL_FLASK_API_ROUTE}/model/process/${modelId}`, { method: 'POST' });

    if (!resp.ok)
        return buildErrorResponse(res, 500, `Error processing model ${modelId}`);

    const data = (await resp.json()).data;

    if (!data)
        return buildErrorResponse(res, 500, `Error processing model ${modelId}`);

    const existingSensors = await fetch(`${process.env.SENSORS_API_ROUTE}/model/${modelId}`);

    if (!existingSensors.ok)
        return buildErrorResponse(res, 500, `Error fetching existing sensors for model ${modelId}`);

    const existingSensorsId = (await existingSensors.json()).data.map((sensor: any) => sensor.guid);

    const createdSensors = [];

    for (const [sensorGuid, sensorData] of Object.entries(data)) {
        try {
            // If there is already a sensor with the same guid and model_id, skip it
            if (existingSensorsId.includes(sensorGuid.toString()))
                continue;
            
            createdSensors.push(await sensorDb.createSensor({
                name: sensorData.name,
                guid: sensorGuid,
                room_id: sensorData.space,
                x: sensorData.x,
                y: sensorData.y,
                z: sensorData.z,
                model_id: modelId,
                channels: Object.keys(SensorChannelEnum)
            }));
        } catch (error) {
            console.error(`Error creating sensor ${sensorData.guid}:`, error);
        }
    }

    return buildSuccessResponse(res, 200, { message: `Model ${modelId} processed successfully`, createdSensors });
});

export default app;