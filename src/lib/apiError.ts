import { NextResponse } from "next/server";

export type ApiErrorCode =
  | "AUTH_REQUIRED"
  | "CONFLICT"
  | "FORBIDDEN"
  | "INTERNAL_ERROR"
  | "INVALID_JSON"
  | "NOT_FOUND"
  | "PAYMENT_FAILED"
  | "PAYMENT_REQUIRED"
  | "PAYMENT_UNAVAILABLE"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "TASK_STATE_CONFLICT"
  | "VALIDATION_ERROR"
  | "NOT_SUPPORTED"
  | "EXECUTION_ERROR";

export function apiError(
  code: ApiErrorCode,
  error: string,
  status: number,
  details?: Record<string, unknown>,
  init?: ResponseInit
) {
  return NextResponse.json(
    {
      error,
      code,
      ...(details ? { details } : {}),
    },
    { ...init, status }
  );
}
