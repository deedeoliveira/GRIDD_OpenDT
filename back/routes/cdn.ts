import express from 'express';
import path from 'path';
import { buildErrorResponse } from "../utils/responseHandler.ts";

const app = express();

app.get('/', (req, res) => {
    const filename = req.query.filename as string;

    console.log('Download request for file: ', filename);

    if (!filename) {
        return buildErrorResponse(res, 400, 'Filename is required');
    }

    const filePath = path.join(import.meta.dirname, '../cdn_resources', filename);

    res.download(filePath, filename, (err) => {
        if (err) {
            return buildErrorResponse(res, 500, `Error downloading file : ${err.message}`);
        }
    });
});

export default app;