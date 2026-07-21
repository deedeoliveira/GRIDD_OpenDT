import type { Response } from 'express';

export function buildSuccessResponse<T>(res: Response, status: number, data: T, message?: string | null) : void {
    res.status(status);
    res.json({
        status,
        data,
        message,
        ok: true
    });
}

export function buildErrorResponse(
    res: Response,
    status: number,
    message: string,
    code = 'request_failed',
    details: unknown = null
): void {
    res.status(status);
    res.json({
        ok: false,
        status,
        code,
        message,
        details,
        error: message
    });
}
