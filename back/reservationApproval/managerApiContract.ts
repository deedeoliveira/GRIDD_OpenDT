import type { Response } from 'express';
import { buildErrorResponse, buildSuccessResponse } from '../utils/responseHandler.ts';
import { ReservationApprovalError } from './reservationApprovalService.ts';

export async function runManagerRequest(res: Response, operation: () => Promise<unknown>) {
  try {
    return buildSuccessResponse(res, 200, await operation());
  } catch (error) {
    const known = error instanceof ReservationApprovalError;
    const code = known ? error.code : 'reservation_management_failed';
    const httpStatus = known ? error.httpStatus : 500;
    console.error(JSON.stringify({ event: 'reservation_manager_request_failed', code, httpStatus, at: new Date().toISOString() }));
    return buildErrorResponse(
      res,
      httpStatus,
      known ? error.message : 'The reservation management request could not be completed.',
      code
    );
  }
}
