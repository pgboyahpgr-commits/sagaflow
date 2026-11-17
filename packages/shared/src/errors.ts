import type { ErrorCode } from './constants.js';
import type { ApiErrorBody, ApiErrorDetail } from './schemas.js';

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: ErrorCode | string;
  public readonly errors?: ApiErrorDetail[];

  constructor(
    status: number,
    code: ErrorCode | string,
    message: string,
    errors?: ApiErrorDetail[]
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.errors = errors;
  }

  toJSON(): ApiErrorBody {
    const body: ApiErrorBody = {
      code: this.code,
      message: this.message,
    };
    if (this.errors && this.errors.length > 0) {
      body.errors = this.errors;
    }
    return body;
  }
}
