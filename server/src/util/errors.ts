/**
 * Every error that reaches a user goes through here, so the browser always gets
 * `{ error: { code, message } }` with a message that is safe and readable.
 * Stack traces and SQL never leave the server.
 */
export class AppError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const badRequest = (message: string, code = 'bad_request') => new AppError(400, code, message);
export const unauthorized = (message: string, code = 'unauthorized') => new AppError(401, code, message);
export const forbidden = (message: string, code = 'forbidden') => new AppError(403, code, message);
export const notFound = (message: string, code = 'not_found') => new AppError(404, code, message);
export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message);
export const tooLarge = (message: string, code = 'too_large') => new AppError(413, code, message);
