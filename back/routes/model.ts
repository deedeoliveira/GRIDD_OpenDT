import express from 'express';
import path from 'path';
import multer from 'multer';
import { buildErrorResponse, buildSuccessResponse } from "../utils/responseHandler.ts";
import db from '../utils/modelDatabase.ts';
import sensorDb from '../utils/sensorDatabase.ts';
import fs from 'fs';
import { SensorChannelEnum } from '../types/sensors.ts';

//Andressa
import inventoryDb from "../utils/inventoryDatabase.ts";
import versionDb from "../utils/modelVersionDatabase.ts";
import { handleModelUpload } from "../services/modelUploadService.ts";
import { resolveStorageKey } from "../utils/storage.ts";
import fsSync from 'fs';
import { ApplicationIdentityDatabase } from "../applicationIdentity/applicationIdentityDatabase.ts";

async function requireWorkspace(req: express.Request, res: express.Response, allowed: Array<"student" | "manager">) {
    if (!req.applicationIdentity) {
        buildErrorResponse(res, 401, "A local development session is required.");
        return false;
    }
    const area = await new ApplicationIdentityDatabase().applicationArea(Number(req.applicationIdentity.accountId));
    if (area === "none" || !allowed.includes(area)) {
        buildErrorResponse(res, 403, "This model resource is not available to the current workspace.");
        return false;
    }
    return true;
}

const app = express();

const MODELS_TEMP_ROOT_PATH = path.join(import.meta.dirname, '../cdn_resources/models/temp');
const MODELS_ROOT_PATH = path.join(import.meta.dirname, '../cdn_resources/models');

const upload = multer({ dest: MODELS_TEMP_ROOT_PATH });

app.get('/student-contexts', async (req, res) => {
    try {
        if (!await requireWorkspace(req, res, ["student"])) return;
        return buildSuccessResponse(res, 200, await db.listStudentModelContexts());
    } catch (error: any) {
        return buildErrorResponse(res, 500, error.message);
    }
});

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

//Andressa atualizou (Prompt 2: fluxo por etapas com versões imutáveis)
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file && !req.body?.fileUrl)
        return buildErrorResponse(res, 400, 'File or file location is required');

    if ((req as any).fileUrl) {
        return buildErrorResponse(res, 501, 'Upload from URL not implemented yet');
    }

    const name = req.body.name || req.file!.originalname.split('.')[0];
    const linkedParentId = req.body.linkedParentId;
    const modelId = req.body.modelId;

    try {
        const result = await handleModelUpload({
            tempFilePath: req.file!.path,
            originalFilename: req.file!.originalname,
            name,
            modelId: modelId ? Number(modelId) : undefined,
            linkedParentId: linkedParentId ? Number(linkedParentId) : undefined,
            description: req.body.description ?? null,
        });

        if (result.isNewModel) {
            return buildSuccessResponse(res, 201, {
                id: result.modelId,
                name,
                linkedParentId: result.linkedParentId,
                versionId: result.versionId,
                versionNumber: result.versionNumber,
                message: "Model uploaded and inventory processed successfully"
            });
        }

        return buildSuccessResponse(res, 200, {
            id: result.modelId,
            versionId: result.versionId,
            versionNumber: result.versionNumber,
            message: `Model ${result.modelId} updated and inventory processed successfully`
        });

    } catch (error: any) {
        // Falhas de requisitos de informação espacial (spatial_preflight)
        // devolvem 422 com mensagem específica; o resto mantém 500.
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        return buildErrorResponse(res, status, error.message);
    }
});

/* ==========================================================
   Versões (Prompt 2)
========================================================== */

/* Metadados de uma versão específica */
app.get('/versions/:versionId', async (req, res) => {
    const versionId = Number(req.params.versionId);

    if (!Number.isInteger(versionId) || versionId <= 0) {
        return buildErrorResponse(res, 400, 'Valid version ID is required');
    }

    try {
        const version = await versionDb.getVersionById(versionId);

        if (!version) {
            return buildErrorResponse(res, 404, `Version ${versionId} not found`);
        }

        return buildSuccessResponse(res, 200, version);
    } catch (error: any) {
        return buildErrorResponse(res, 500, error.message);
    }
});

/* Download do ficheiro de uma versão específica (corrente ou histórica) */
app.get('/versions/:versionId/download', async (req, res) => {
    const versionId = Number(req.params.versionId);

    if (!Number.isInteger(versionId) || versionId <= 0) {
        return buildErrorResponse(res, 400, 'Valid version ID is required');
    }

    try {
        if (!await requireWorkspace(req, res, ["student", "manager"])) return;
        const version = await versionDb.getVersionById(versionId);

        if (!version) {
            return buildErrorResponse(res, 404, `Version ${versionId} not found`);
        }

        if (!version.storage_key) {
            return buildErrorResponse(res, 404, `Version ${versionId} has no recoverable file (historical limitation)`);
        }

        const filePath = resolveStorageKey(version.storage_key);

        if (!fsSync.existsSync(filePath)) {
            return buildErrorResponse(res, 404, `File for version ${versionId} not found on storage`);
        }

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename=model_${version.model_id}_v${version.version_number}.ifc`);
        res.send(fsSync.readFileSync(filePath));
    } catch (error: any) {
        return buildErrorResponse(res, 500, error.message);
    }
});

/* Lista de versões de um modelo */
app.get('/:modelId/versions', async (req, res) => {
    const modelId = Number(req.params.modelId);

    if (!Number.isInteger(modelId) || modelId <= 0) {
        return buildErrorResponse(res, 400, 'Valid model ID is required');
    }

    try {
        const versions = await versionDb.getVersionsByModel(modelId);
        return buildSuccessResponse(res, 200, versions);
    } catch (error: any) {
        return buildErrorResponse(res, 500, error.message);
    }
});

/* Versão corrente de um modelo (referência explícita, não "maior id") */
app.get('/:modelId/current', async (req, res) => {
    const modelId = Number(req.params.modelId);

    if (!Number.isInteger(modelId) || modelId <= 0) {
        return buildErrorResponse(res, 400, 'Valid model ID is required');
    }

    try {
        const version = await versionDb.getCurrentVersion(modelId);

        if (!version) {
            return buildErrorResponse(res, 404, `Model ${modelId} has no current version`);
        }

        return buildSuccessResponse(res, 200, version);
    } catch (error: any) {
        return buildErrorResponse(res, 500, error.message);
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

    const data = ((await resp.json()) as any).data;

    if (!data)
        return buildErrorResponse(res, 500, `Error processing model ${modelId}`);

    const existingSensors = await fetch(`${process.env.SENSORS_API_ROUTE}/model/${modelId}`);

    if (!existingSensors.ok)
        return buildErrorResponse(res, 500, `Error fetching existing sensors for model ${modelId}`);

    const existingSensorsId = ((await existingSensors.json()) as any).data.map((sensor: any) => sensor.guid);

    const createdSensors = [];

    for (const [sensorGuid, sensorData] of Object.entries(data) as [string, any][]) {
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
                channels: Object.keys(SensorChannelEnum) as any
            }));
        } catch (error) {
            console.error(`Error creating sensor ${sensorData.guid}:`, error);
        }
    }

    return buildSuccessResponse(res, 200, { message: `Model ${modelId} processed successfully`, createdSensors });
});

//Andressa
app.post('/preprocess/:modelId/:versionId', async (req, res) => {
    const { modelId, versionId } = req.params;

    if (!modelId || !versionId) {
        return buildErrorResponse(res, 400, 'Model ID and Version ID are required');
    }

    try {

        // 🔹 Extrair inventário do IFC (usando modelId para localizar arquivo)
        const invResp = await fetch(
            `${process.env.IFCOPENSHELL_FLASK_API_ROUTE}/model/inventory/${modelId}`,
            { method: 'POST' }
        );

        if (!invResp.ok) {
            return buildErrorResponse(res, 500, `Error extracting inventory for model ${modelId}`);
        }

        const invPayload = await invResp.json();

        if (!invPayload?.data) {
            return buildErrorResponse(res, 500, `Inventory extraction failed`);
        }

        // 🔹 Salvar snapshot associado à versão
        await inventoryDb.saveInventorySnapshot(Number(versionId), invPayload.data);

        return buildSuccessResponse(res, 200, {
            message: `Inventory snapshot saved successfully`,
            modelId,
            versionId
        });

    } catch (error: any) {
        return buildErrorResponse(res, 500, error.message);
    }
});

export default app;
