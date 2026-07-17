export class ApiError extends Error {
  status: number;
  errorType: string;
  details: string[] | null;
  constructor(status: number, errorType: string, message: string, details: string[] | null = null) {
    super(message);
    this.status = status;
    this.errorType = errorType;
    this.details = details;
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
    let details: string[] | null = null;
    try {
      const body = await res.json();
      if (body?.error) {
        type = body.error.type;
        message = body.error.message;
        details = body.error.details ?? null;
      }
    } catch {
      // keep the status text
    }
    throw new ApiError(res.status, type, message, details);
  }
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
};

export function describeError(e: unknown): string {
  if (e instanceof ApiError && e.details?.length) {
    return `${e.message}: ${e.details.join(' · ')}`;
  }
  return (e as Error)?.message ?? String(e);
}
