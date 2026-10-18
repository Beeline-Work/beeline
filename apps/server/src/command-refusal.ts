export class CommandRefusalError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 | 410,
  ) {
    super(message);
  }
}
