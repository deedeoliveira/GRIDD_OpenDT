export type NormalizedProxyResponse = { status: number; body: string };

function errorBody(status: number, code: string) {
  return JSON.stringify({ ok: false, status, code, message: 'The reservation service returned an invalid response.', details: null });
}

export function normalizeManagerProxyResponse(status: number, contentType: string | null, body: string): NormalizedProxyResponse {
  const outputStatus = status === 204 ? 502 : status;
  if (body.trim() && (contentType ?? '').toLowerCase().includes('application/json')) {
    try { JSON.parse(body); return { status: outputStatus, body }; }
    catch { /* normalized below */ }
  }
  return { status: outputStatus, body: errorBody(outputStatus, body.trim() ? 'manager_proxy_invalid_response' : 'manager_proxy_empty_response') };
}
