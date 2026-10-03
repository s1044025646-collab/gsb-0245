export type ErrorCode =
  | "INVALID_DIMENSION"
  | "OUT_OF_BOUNDS"
  | "NON_INTEGER"
  | "LIMIT_EXCEEDED"
  | "DIM_MISMATCH"
  | "NOT_FOUND"
  | "DUPLICATE_VERSION"
  | "BAD_REQUEST";

export class ApiError extends Error {
  constructor(public code: ErrorCode, message: string, public status = 400) {
    super(message);
  }
}
