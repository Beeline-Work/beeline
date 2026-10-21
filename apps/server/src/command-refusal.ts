/** An expected caller refusal; capture boundaries must leave its response intact. */
export class ExpectedRefusalError extends Error {}

export class CommandRefusalError extends ExpectedRefusalError {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 | 429,
  ) {
    super(message);
  }
}
