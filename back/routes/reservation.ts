import express from 'express';
import reservationDb from '../utils/reservationDatabase.ts';
import { buildSuccessResponse, buildErrorResponse } from '../utils/responseHandler.ts';

const app = express();

app.use(express.json());

app.get('/asset/:assetId', async (req, res) => {
  const { assetId } = req.params;

  try {
    const reservations = await reservationDb.getReservationsByAsset(
      Number(assetId)
    );

    return buildSuccessResponse(res, 200, reservations);

  } catch (error: any) {
    return buildErrorResponse(res, 500, error.message);
  }
});

app.get("/actor/:actorId", async (req, res) => {
  const { actorId } = req.params;

  try {
    const rows = await reservationDb.getReservationsByActor(actorId);
    return buildSuccessResponse(res, 200, rows);
  } catch (error: any) {
    return buildErrorResponse(res, 500, error.message);
  }
});


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
  const { reservationId, actorId } = req.body;

  if (!reservationId || !actorId) {
    return buildErrorResponse(res, 400, 'Missing reservationId or actorId');
  }

  try {
    const result = await reservationDb.checkIn(
      Number(reservationId),
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

app.post('/cancel', async (req, res) => {
  const { reservationId, actorId } = req.body;

  if (!reservationId || !actorId) {
    return buildErrorResponse(res, 400, 'Missing reservationId or actorId');
  }

  try {
    const result = await reservationDb.cancelReservation(
      Number(reservationId),
      actorId
    );

    return buildSuccessResponse(res, 200, result);

  } catch (error: any) {
    return buildErrorResponse(res, 400, error.message);
  }
});






export default app;
