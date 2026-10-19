export class CommandRefusalError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 | 429,
  ) {
    super(message);
  }
}
