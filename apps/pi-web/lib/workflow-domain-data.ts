/** JSON crossing a Host boundary is untrusted until its consumed fields are checked. */
export type JsonRecord = Record<string, unknown>;
export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function record(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error("Workflow data must be an object");
  return value;
}
export function parseRecord(text: string): JsonRecord { return record(JSON.parse(text) as unknown); }
export function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => isRecord(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
