import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

test("PDF renderer serves local engine/worker assets and rejects arbitrary package paths", async () => {
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { GET } = await jiti.import("../app/api/pdfjs/[...path]/route.ts");
  const request = new Request("http://127.0.0.1:30141/api/pdfjs/build/pdf.min.mjs", { headers: { host: "127.0.0.1:30141" } });
  for (const path of [["build", "pdf.min.mjs"], ["build", "pdf.worker.min.mjs"]]) {
    const response = await GET(request, { params: Promise.resolve({ path }) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "text/javascript");
    assert.ok((await response.text()).length > 10000, "serve the installed renderer bytes, not a redirect or HTML page");
  }
  for (const path of [["package.json"], ["..", "..", "package.json"], ["build", "pdf.sandbox.min.mjs"]]) {
    assert.equal((await GET(request, { params: Promise.resolve({ path }) })).status, 404);
  }
  const untrusted = new Request(request.url, { headers: { host: "attacker.invalid" } });
  assert.equal((await GET(untrusted, { params: Promise.resolve({ path: ["build", "pdf.min.mjs"] }) })).status, 403);
});
