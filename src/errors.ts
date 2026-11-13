export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public error: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
