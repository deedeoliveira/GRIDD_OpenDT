import express from 'express';
import reservationDb from '../utils/reservationDatabase.ts';
import { buildSuccessResponse, buildErrorResponse } from '../utils/responseHandler.ts';
import { loadSemanticEvidenceConfig } from '../semanticEvidence/semanticEvidenceConfig.ts';
import { getReservationSemanticEvidenceService } from '../semanticEvidence/semanticEvidenceRuntime.ts';
import { SemanticEvidenceError, sanitizedSemanticEvidenceError } from '../semanticEvidence/semanticEvidenceTypes.ts';
import { assertCurrentApplicationActor, resolveCurrentApplicationActor } from "../reservation/currentApplicationActor.ts";

const app = express();

app.use(express.json());

app.get('/current-actor', (_req, res) => buildSuccessResponse(res, 200, {
  actorKey: resolveCurrentApplicationActor(),
  authenticated: false,
  caveat: 'development_identity_not_authenticated',
}));

app.post('/evidence', async (req, res) => {
  try {
    const actorKey = assertCurrentApplicationActor(req.body?.actorKey);
    const evidence = await getReservationSemanticEvidenceService().evaluate({
      actorKey,
      assetId: Number(req.body?.assetId),
      start: String(req.body?.start ?? ''),
      end: String(req.body?.end ?? ''),
    });
    return buildSuccessResponse(res, 201, evidence);
  } catch (error) {
    if ((error as any)?.httpStatus) return buildErrorResponse(res, (error as any).httpStatus, (error as Error).message);
    const safe = sanitizedSemanticEvidenceError(error);
    return buildErrorResponse(res, error instanceof SemanticEvidenceError ? error.httpStatus : 500, safe.message);
  }
});

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
  const { assetId, actorId, startTime, endTime, semanticEvidenceRunUuid } = req.body;

  if (!assetId || !startTime || !endTime) {
    return buildErrorResponse(res, 400, 'Missing required fields');
  }

  try {
    const currentActor = assertCurrentApplicationActor(actorId);
    const evidenceConfig = loadSemanticEvidenceConfig();
    const start = new Date(startTime);
    const end = new Date(endTime);
    if (semanticEvidenceRunUuid && evidenceConfig.enabled && evidenceConfig.mode === 'shadow') {
      await getReservationSemanticEvidenceService().assertMatchesAndLink({
        runUuid: String(semanticEvidenceRunUuid), actorKey: currentActor, assetId: Number(assetId), start, end,
      });
    }
    const reservationId = await reservationDb.createReservation(
      Number(assetId),
      currentActor,
      start,
      end
    );

    let evidenceLinked = false;
    if (semanticEvidenceRunUuid && evidenceConfig.enabled && evidenceConfig.mode === 'shadow') {
      try {
        await getReservationSemanticEvidenceService().assertMatchesAndLink({
          runUuid: String(semanticEvidenceRunUuid), actorKey: currentActor, assetId: Number(assetId), start, end, reservationId,
        });
        evidenceLinked = true;
      } catch (linkError) {
        console.error(JSON.stringify({ type: 'reservation_evidence_link_failed', reservationId,
          errorCode: linkError instanceof SemanticEvidenceError ? linkError.code : 'evidence_link_failed', at: new Date().toISOString() }));
      }
    }

    return buildSuccessResponse(res, 201, {
      message: 'Reservation request created',
      reservationId,
      status: 'pending',
      semanticEvidenceRunUuid: semanticEvidenceRunUuid ?? null,
      evidenceLinked
    });

  } catch (error: any) {
    return buildErrorResponse(res, error instanceof SemanticEvidenceError ? error.httpStatus : 400, error.message);
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
  const { reservationId, actorId } = req.body;

  console.log("checkout em routes - reservationID:", reservationId);
  console.log("checkout em routes - actorId:", actorId);

  if (!reservationId || !actorId) {
    return buildErrorResponse(res, 400, 'Missing reservationId or actorId');
  }

  try {
    const result = await reservationDb.checkOut(
      Number(reservationId),
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
