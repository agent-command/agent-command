/** HTTP API errors: a closed `[a-z_]` code from the server's `{ error }` body, else `http_<status>`. No SDK imports. */
export class ApiError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** The ApiError for a failed response. */
export async function apiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && /^[a-z_]{1,32}$/.test(body.error)) return new ApiError(body.error);
  } catch {
    /* non-JSON error body: keep the status code */
  }
  return new ApiError(`http_${res.status}`);
}
