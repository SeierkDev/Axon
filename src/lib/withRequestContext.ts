import { type NextRequest } from "next/server";
import { runWithRequestId, generateRequestId } from "./requestContext";

// Wraps a route handler body so every logger.* call within the async call chain
// automatically includes the request ID. The ID is read from the X-Request-ID
// header (set by middleware) or generated fresh if absent.
export function withRequestContext<T>(req: NextRequest, fn: () => Promise<T>): Promise<T> {
  const id = req.headers.get("x-request-id") ?? generateRequestId();
  return runWithRequestId(id, fn);
}
