import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const require = createRequire(import.meta.url);
export async function GET() {
  const source = await readFile(require.resolve("plotly.js-strict-dist-min/plotly-strict.min.js"));
  return new Response(source, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
}
