// Small JSON request helper for interface modules; surfaces the server's `error` message.
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.method && init.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* Keep the HTTP error. */
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  return request<T>(path, { method, body: JSON.stringify(body ?? {}) });
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
