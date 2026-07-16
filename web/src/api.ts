export class ApiError extends Error {
  status: number;
  errorType: string;
  constructor(status: number, errorType: string, message: string) {
    super(message);
    this.status = status;
    this.errorType = errorType;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let type = 'api_error';
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) {
        type = body.error.type;
        message = body.error.message;
      }
    } catch {
      // keep the status text
    }
    throw new ApiError(res.status, type, message);
  }
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export function streamSession(sessionId: string, onEvent: (event: unknown) => void): () => void {
  const source = new EventSource(`/v1/sessions/${sessionId}/stream`);
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data));
    } catch {
      // ignore malformed frames
    }
  };
  return () => source.close();
}
