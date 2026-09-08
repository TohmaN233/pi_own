import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import nft from "next/dist/compiled/@vercel/nft/index.js";

test("production tracing never packages the runtime user's home directory", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-home-trace-"));
  const previous = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  writeFileSync(path.join(root, "private-runtime-file.txt"), "Runtime user data is not a build dependency.");
  try {
    const entries = ["lib/directory-browser.ts", "lib/file-access.ts"].map(file => path.resolve(file));
    const result = await nft.nodeFileTrace(entries, {
      base: path.parse(entries[0]).root,
      // Match Next's external-package boundary and keep this regression focused
      // on directory discovery rather than the unrelated session parser graph.
      ignore: ["**/node_modules/**", "**/lib/session-reader.ts"],
      mixedModules: true,
      async readFile(file) {
        let source;
        try { source = readFileSync(file, "utf8"); }
        catch (error) { if (error.code === "ENOENT" || error.code === "EISDIR") return null; throw error; }
        return file.endsWith(".ts")
          ? ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
          : source;
      },
    });
    assert.ok([...result.fileList].some(file => file.endsWith("runtime-home.ts")), "The runtime helper must still be traced as application code");
    assert.ok(![...result.fileList].some(file => file.includes("private-runtime-file.txt")), "The user's files must not enter the production dependency trace");
  } finally {
    if (previous === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
