import express from 'express';
import reservationDb from '../utils/reservationDatabase.ts';
import { buildSuccessResponse, buildErrorResponse } from '../utils/responseHandler.ts';
import { loadSemanticEvidenceConfig } from '../semanticEvidence/semanticEvidenceConfig.ts';
import { getReservationSemanticEvidenceService } from '../semanticEvidence/semanticEvidenceRuntime.ts';
import { SemanticEvidenceError, sanitizedSemanticEvidenceError } from '../semanticEvidence/semanticEvidenceTypes.ts';
import { assertCurrentApplicationActor, resolveCurrentApplicationActor } from "../reservation/currentApplicationActor.ts";
import { applicationIdentityRuntime } from "../applicationIdentity/applicationIdentityMiddleware.ts";
import { ApplicationIdentityDatabase } from "../applicationIdentity/applicationIdentityDatabase.ts";

const app = express();

app.use(express.json());

function currentActor(req: express.Request) { return req.applicationIdentity?.accountKey ?? resolveCurrentApplicationActor(); }
function currentAccountId(req: express.Request) { return req.applicationIdentity?.accountId ?? null; }
function rejectSpoof(req: express.Request, supplied: unknown) { const {config}=applicationIdentityRuntime(); return config.mode==='local_session' ? currentActor(req) : assertCurrentApplicationActor(supplied); }
function requiresLocalIdentity(req: express.Request, res: express.Response) {
  if (applicationIdentityRuntime().config.mode === 'local_session' && !req.applicationIdentity) {
    buildErrorResponse(res, 401, 'A local development session is required.'); return true;
  }
  return false;
}
app.get('/current-actor', (req, res) => buildSuccessResponse(res, 200, req.applicationIdentity ? { actorKey: currentActor(req), accountUuid:req.applicationIdentity.accountUuid, authenticated:false, assurance:'development_only' } : {actorKey:currentActor(req),authenticated:false,caveat:'legacy_development_fallback'}));

app.post('/evidence', async (req, res) => {
  try {
    if (requiresLocalIdentity(req, res)) return;
    const actorKey = rejectSpoof(req, req.body?.actorKey);
    if (req.applicationIdentity) await new ApplicationIdentityDatabase().assertLinkedAccount(req.applicationIdentity.accountId, actorKey);
    const evidence = await getReservationSemanticEvidenceService().evaluate({
      actorKey,
      assetId: Number(req.body?.assetId),
      start: String(req.body?.start ?? ''),
      end: String(req.body?.end ?? ''),
      ...(req.applicationIdentity ? { applicationIdentity: {
        accountId: req.applicationIdentity.accountId, accountUuid: req.applicationIdentity.accountUuid,
        provider: req.applicationIdentity.provider, assurance: req.applicationIdentity.authenticationAssurance,
      } } : {}),
    });
    return buildSuccessResponse(res, 201, evidence);
  } catch (error) {
    const code = String((error as any)?.code ?? 'semantic_evidence_failed');
    const layer = code.startsWith('account_') || code.includes('identity') ? 'account/session'
      : code.startsWith('actor_link') ? 'institutional link'
      : code.startsWith('institutional_') ? 'institutional dataset'
      : code.includes('resource') ? 'resource/model'
      : code.includes('structural') ? 'structural evidence'
      : code.includes('shacl') || code.includes('policy') ? 'policy execution' : 'technical error';
    if ((error as any)?.httpStatus) return res.status((error as any).httpStatus).json({ status:(error as any).httpStatus,
      code, layer, message:(error as Error).message, error:(error as Error).message });
    const safe = sanitizedSemanticEvidenceError(error);
    return res.status(error instanceof SemanticEvidenceError ? error.httpStatus : 500).json({ status:error instanceof SemanticEvidenceError ? error.httpStatus : 500,
      code:safe.code, layer, message:safe.message, error:safe.message });
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
  if (requiresLocalIdentity(req, res)) return;
  const actorId = rejectSpoof(req, req.params.actorId);

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
    if (requiresLocalIdentity(req, res)) return;
    const currentActor = rejectSpoof(req, actorId);
    const evidenceConfig = loadSemanticEvidenceConfig();
    const start = new Date(startTime);
    const end = new Date(endTime);
    if (semanticEvidenceRunUuid && evidenceConfig.enabled && evidenceConfig.mode === 'shadow') {
      await getReservationSemanticEvidenceService().assertMatchesAndLink({
        runUuid: String(semanticEvidenceRunUuid), actorKey: currentActor, assetId: Number(assetId), start, end,
        applicationAccountId: currentAccountId(req) ?? undefined,
      });
    }
    const reservationId = await reservationDb.createReservation(
      Number(assetId),
      currentActor,
      start,
      end,
      currentAccountId(req)
    );

    let evidenceLinked = false;
    if (semanticEvidenceRunUuid && evidenceConfig.enabled && evidenceConfig.mode === 'shadow') {
      try {
        await getReservationSemanticEvidenceService().assertMatchesAndLink({
          runUuid: String(semanticEvidenceRunUuid), actorKey: currentActor, assetId: Number(assetId), start, end, reservationId,
          applicationAccountId: currentAccountId(req) ?? undefined,
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
  const { reservationId } = req.body;
  if (requiresLocalIdentity(req, res)) return;
  const actorId = rejectSpoof(req, req.body?.actorId);

  if (!reservationId) {
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
  const { reservationId } = req.body;
  if (requiresLocalIdentity(req, res)) return;
  const actorId = rejectSpoof(req, req.body?.actorId);

  console.log("checkout em routes - reservationID:", reservationId);
  console.log("checkout em routes - actorId:", actorId);

  if (!reservationId) {
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
  const { reservationId } = req.body;
  if (requiresLocalIdentity(req, res)) return;
  const actorId = rejectSpoof(req, req.body?.actorId);

  if (!reservationId) {
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
