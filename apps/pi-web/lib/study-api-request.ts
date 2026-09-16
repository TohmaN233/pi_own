import { hasJsonContentType } from "./request-security";

/** Reject oversized streams before JSON parsing; all UI actions have explicit fields. */
export async function readStudyRequest(request: Request): Promise<Record<string, unknown>> {
  if (!hasJsonContentType(request) || !request.body) throw new Error("A JSON request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 1024 * 1024) {
        await reader.cancel("Study request exceeds 1 MiB");
        throw new Error("Study request exceeds 1 MiB");
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Study request must be an object");
  return value as Record<string, unknown>;
}

export function studyText(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`Invalid ${name}`);
  return value;
}

export function studyInteger(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export function studyApiError(error: unknown): Response {
  console.error("[study-research] request failed", error);
  const message = publicStudyError(error);
  return Response.json({ error: message }, { status: /conflict|changed|stale/i.test(message) ? 409 : 400, headers: { "cache-control": "no-store" } });
}

/** Keep diagnostics in server logs; transport only bounded messages without private host paths or credentials. */
export function publicStudyError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[A-Za-z]:[\\/][^\r\n"'<>]*/gu, "[local path]")
    .replace(/\\\\[^\r\n"'<>]*/gu, "[local path]")
    .replace(/("(?:token|secret|password|credential|authorization|cookie)"\s*:\s*")[^"\r\n]*(")/giu, "$1[redacted]$2")
    .replace(/((?:token|secret|password|credential|authorization|cookie)\s*[=:]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/(bearer\s+)[^\s,;]+/giu, "$1[redacted]").slice(0, 2000);
}
