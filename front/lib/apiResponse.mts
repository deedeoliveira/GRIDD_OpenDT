export type ApiEnvelope<T> = {
  ok: true;
  status: number;
  data: T;
  message?: string | null;
};

export class ApiResponseError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly technicalDetails: string
  ) {
    super(message);
    this.name = 'ApiResponseError';
  }
}

export async function parseApiJsonResponse<T>(response: Response): Promise<ApiEnvelope<T>> {
  const contentType = response.headers.get('content-type') ?? 'missing';
  const text = await response.text();
  const technical = `HTTP ${response.status}; content-type=${contentType}; body-length=${text.length}`;

  if (!text.trim()) {
    throw new ApiResponseError('The server returned an empty response. Please retry the operation.', 'api_response_empty', response.status, technical);
  }
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiResponseError('The server returned an unexpected response format. Please retry the operation.', 'api_response_unexpected_content_type', response.status, technical);
  }
  let payload: any;
  try { payload = JSON.parse(text); }
  catch { throw new ApiResponseError('The server returned an invalid response. Please retry the operation.', 'api_response_invalid_json', response.status, technical); }
  if (!response.ok || payload?.ok === false) {
    throw new ApiResponseError(
      typeof payload?.message === 'string' ? payload.message : 'The request could not be completed.',
      typeof payload?.code === 'string' ? payload.code : 'api_request_failed',
      response.status,
      `${technical}; code=${typeof payload?.code === 'string' ? payload.code : 'missing'}`
    );
  }
  if (payload?.ok !== true || !Object.prototype.hasOwnProperty.call(payload, 'data')) {
    throw new ApiResponseError('The server response did not match the expected contract.', 'api_response_contract_invalid', response.status, technical);
  }
  return payload as ApiEnvelope<T>;
}
