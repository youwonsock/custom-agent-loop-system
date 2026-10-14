export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code = "invalid_request",
    readonly details?: unknown,
  ) {
    super(message);
  }
}
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
