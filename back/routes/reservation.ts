import express from 'express';
import reservationDb from '../utils/reservationDatabase.ts';
import { buildSuccessResponse, buildErrorResponse } from '../utils/responseHandler.ts';

const app = express();

app.use(express.json());

app.post('/request', async (req, res) => {
  const { assetId, actorId, startTime, endTime } = req.body;

  if (!assetId || !actorId || !startTime || !endTime) {
    return buildErrorResponse(res, 400, 'Missing required fields');
  }

  try {
    const reservationId = await reservationDb.createReservation(
      Number(assetId),
      actorId,
      new Date(startTime),
      new Date(endTime)
    );

    return buildSuccessResponse(res, 201, {
      message: 'Reservation request created',
      reservationId
    });

  } catch (error: any) {
    return buildErrorResponse(res, 400, error.message);
  }
});

app.post('/checkin', async (req, res) => {
  const { assetId, actorId } = req.body; // temporariamente

  if (!assetId || !actorId) {
    return buildErrorResponse(res, 400, 'Missing assetId or actorId');
  }

  try {
    const result = await reservationDb.checkIn(
      Number(assetId),
      actorId
    );

    return buildSuccessResponse(res, 200, result);

  } catch (error: any) {
    return buildErrorResponse(res, 400, error.message);
  }
});

app.post('/checkout', async (req, res) => {
  const { assetId, actorId } = req.body;

  if (!assetId || !actorId) {
    return buildErrorResponse(res, 400, 'Missing assetId or actorId');
  }

  try {
    const result = await reservationDb.checkOut(
      Number(assetId),
      actorId
    );

    return buildSuccessResponse(res, 200, result);

  } catch (error: any) {
    return buildErrorResponse(res, 400, error.message);
  }
});


export default app;
