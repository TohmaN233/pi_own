import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  appendSubagentInputFiles,
  loadSubagentInputFiles,
  MAX_SUBAGENT_INPUT_BYTES,
  MAX_SUBAGENT_INPUT_FILES,
} = await createJiti(import.meta.url).import("./subagent-input.ts");

test("loads cwd-relative UTF-8 files and formats them as delegated user input", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-input-"));
  try {
    await mkdir(join(cwd, "docs"));
    await writeFile(join(cwd, "docs", "article.md"), "# Article\n\nEvidence.", "utf8");

    const files = loadSubagentInputFiles(cwd, ["docs/article.md"]);
    assert.deepEqual(files, [{ path: "docs/article.md", content: "# Article\n\nEvidence." }]);
    assert.equal(
      appendSubagentInputFiles("Analyze the argument.", files),
      "Analyze the argument.\n\n<documents>\n<document path=\"docs/article.md\">\n# Article\n\nEvidence.\n</document>\n</documents>",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects direct files outside cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-input-cwd-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-web-subagent-input-outside-"));
  try {
    const outsideFile = join(outside, "article.md");
    await writeFile(outsideFile, "Private", "utf8");
    assert.throws(() => loadSubagentInputFiles(cwd, [outsideFile]), /outside the session cwd/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects symlink targets outside cwd", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-input-cwd-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-web-subagent-input-outside-"));
  try {
    const outsideFile = join(outside, "article.md");
    await writeFile(outsideFile, "Private", "utf8");
    try {
      await symlink(outsideFile, join(cwd, "linked.md"));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
        t.skip("symbolic-link creation requires Windows Developer Mode or elevated privileges");
        return;
      }
      throw error;
    }

    assert.throws(() => loadSubagentInputFiles(cwd, ["linked.md"]), /outside the session cwd/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects invalid UTF-8 and bounded input sets", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagent-input-"));
  try {
    await writeFile(join(cwd, "binary.txt"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(cwd, "large.txt"), "x".repeat(MAX_SUBAGENT_INPUT_BYTES + 1), "utf8");

    assert.throws(() => loadSubagentInputFiles(cwd, ["binary.txt"]), /not valid UTF-8/);
    assert.throws(() => loadSubagentInputFiles(cwd, ["large.txt"]), /total limit/);
    assert.throws(
      () => loadSubagentInputFiles(cwd, Array(MAX_SUBAGENT_INPUT_FILES + 1).fill("binary.txt")),
      /at most/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
