// Serializes a task's context object into a readable appendix for the model.
// Keys become labels; nested objects are JSON-encoded inline.
export function formatContext(ctx: Record<string, unknown> | undefined): string {
  if (!ctx) return "";
  const lines = Object.entries(ctx)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return lines.length > 0 ? `\n\nContext:\n${lines.join("\n")}` : "";
}
