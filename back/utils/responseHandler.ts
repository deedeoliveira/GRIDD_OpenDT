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

export function buildErrorResponse(res: Response, status: number, message: string): void {
    res.status(status);
    res.json({
        status,
        message,
        error: message
    });
}