import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const chunkPaths = [0, 1, 2, 3].map((index) =>
  join(root, "scripts", `.mode-pack-p1.${index}`),
);
const bootstrapPaths = [
  ...chunkPaths,
  fileURLToPath(import.meta.url),
  join(root, ".github", "workflows", "apply-mode-pack-p1.yml"),
];

const archiveNames = [
  "mode-pack-runtime.ts",
  "mode-pack-session-store.ts",
  "mode-pack-pi-resources.ts",
  "mode-pack-workflow-runtime.ts",
  "mode-pack-pi-runtime.ts",
  "mode-pack-service.ts",
  "mode-pack-client.ts",
  "mode-pack-session-route.ts",
  "agent-id-route.ts",
  "education-persistence.ts",
  "HarnessShell.tsx",
  "HarnessShell.test.mjs",
  "mode-pack-pi-runtime.test.mjs",
  "mode-pack-session-runtime.test.mjs",
  "mode-pack-workflow-runtime.test.mjs",
  "mode-pack-live-wiring.test.mjs",
  "mode-pack-checkpoint.yml",
];

const targets = {
  "mode-pack-runtime.ts": "apps/pi-web/lib/mode-pack-runtime.ts",
  "mode-pack-session-store.ts": "apps/pi-web/lib/mode-pack-session-store.ts",
  "mode-pack-pi-resources.ts": "apps/pi-web/lib/mode-pack-pi-resources.ts",
  "mode-pack-workflow-runtime.ts": "apps/pi-web/lib/mode-pack-workflow-runtime.ts",
  "mode-pack-pi-runtime.ts": "apps/pi-web/lib/mode-pack-pi-runtime.ts",
  "mode-pack-service.ts": "apps/pi-web/lib/mode-pack-service.ts",
  "mode-pack-client.ts": "apps/pi-web/lib/mode-pack-client.ts",
  "mode-pack-session-route.ts": "apps/pi-web/app/api/mode-packs/session/route.ts",
  "agent-id-route.ts": "apps/pi-web/app/api/agent/[id]/route.ts",
  "education-persistence.ts": "packages/education-mode-host/src/persistence.ts",
  "HarnessShell.tsx": "apps/pi-web/components/harness/HarnessShell.tsx",
  "HarnessShell.test.mjs": "apps/pi-web/components/harness/HarnessShell.test.mjs",
  "mode-pack-pi-runtime.test.mjs": "apps/pi-web/lib/mode-pack-pi-runtime.test.mjs",
  "mode-pack-session-runtime.test.mjs": "scripts/mode-pack-session-runtime.test.mjs",
  "mode-pack-workflow-runtime.test.mjs": "scripts/mode-pack-workflow-runtime.test.mjs",
  "mode-pack-live-wiring.test.mjs": "scripts/mode-pack-live-wiring.test.mjs",
  "mode-pack-checkpoint.yml": ".github/workflows/mode-pack-checkpoint.yml",
};

const expectedHashes = {
  "mode-pack-runtime.ts": "b8dbd5d9d485fbb1afc7bceeb3ba6b097ce5338146f43980fcd72cd74ae7010c",
  "mode-pack-session-store.ts": "93ad5d4c5e88ba4957cb775cef6ef2cf26acb99c07afc5ca133fe31d7a95e41b",
  "mode-pack-pi-resources.ts": "0a53ca63fbb3e434869781d119d56d61aed199e634630c5747fe6f670269c0e9",
  "mode-pack-workflow-runtime.ts": "f0ec788f8aeb9202382885f950a2a3dd6092b9cdffc92a08ab2a69d6d703f6ec",
  "mode-pack-pi-runtime.ts": "a244f65dc916c255cb25b45e59d2f4cff41ba77b08205d94ac00184fdcb27b2",
  "mode-pack-service.ts": "e95a6b0ccba0108a5e73e70cc14d7dd723ad812098cb6c642356b73940542fa2",
  "mode-pack-client.ts": "54c19aee2bd44ec9c0cb528fe5e4de924e186f9bffdf0827b3a87dd6d22559a8",
  "mode-pack-session-route.ts": "21b67b439c0ed20c35db001579e16365a704db980a0d2a05466a2973dc17e2ba",
  "agent-id-route.ts": "69ffd6e9e92e4969c9b35d5a19252e51629fcb6b83237978fab28cfd98a57fcc",
  "education-persistence.ts": "c5f5266d50a25c7994ec55700f895de0b279f6fd2486cd15d8d2f317923465a6",
  "HarnessShell.tsx": "a114f170daa92fc8d4fe5bf95dc294dc322d2e8f8bbf7485d6c00184fdcb27b2",
  "HarnessShell.test.mjs": "d21ad7232362e9f0f2a33c451f98dd6db090cb93b78bea2485ab6406c9f32d42",
  "mode-pack-pi-runtime.test.mjs": "887b87fc03b28b5e833c94f6bd08958aca6d3516f9eb2170b314aeb0273274c5",
  "mode-pack-session-runtime.test.mjs": "1ed26a5c97c4abe654d7b6f8e880d61c6c86ba50271308a777fdebca51cecd16",
  "mode-pack-workflow-runtime.test.mjs": "f89b5fe5a81c89d7f393d7654f419a9434d296fb8d82d4c4b1a0af0680e618be",
  "mode-pack-live-wiring.test.mjs": "7fb034ffd429631384818b39cf7b6247092c15eb1d1222e15858fd92cb6c1177",
  "mode-pack-checkpoint.yml": "221b495c849e9b37e1947f074aa04cbf5dff13d1b0001e4625c6fb678ccc3238",
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const encoded = chunkPaths.map((path) => readFileSync(path, "utf8").trim()).join("");
if (sha256(encoded) !== "36f538307288d50364cabbf345de317493c107afbf7ba624ffa249b3b7a951b0") {
  throw new Error("Mode Pack P1 bootstrap payload chunks failed integrity validation");
}

const archiveBytes = Buffer.from(encoded, "base64");
if (sha256(archiveBytes) !== "081ee82d131c61e0826f0ee3095ffc6751baf9b4b42e69190a849984ebe090df") {
  throw new Error("Mode Pack P1 bootstrap archive failed integrity validation");
}

const temporary = mkdtempSync(join(tmpdir(), "pi-own-mode-pack-p1-"));
const archivePath = join(temporary, "payload.tar.gz");
try {
  writeFileSync(archivePath, archiveBytes);
  const listed = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" })
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort();
  const expectedNames = [...archiveNames].sort();
  if (JSON.stringify(listed) !== JSON.stringify(expectedNames)) {
    throw new Error("Mode Pack P1 archive contains an unexpected file set");
  }
  execFileSync("tar", ["-xzf", archivePath, "-C", temporary], { stdio: "inherit" });

  for (const sourceName of archiveNames) {
    const sourcePath = join(temporary, sourceName);
    const bytes = readFileSync(sourcePath);
    if (sha256(bytes) !== expectedHashes[sourceName]) {
      throw new Error(`Mode Pack P1 payload hash mismatch for ${sourceName}`);
    }
    const targetPath = join(root, targets[sourceName]);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
    if (sha256(readFileSync(targetPath)) !== expectedHashes[sourceName]) {
      throw new Error(`Mode Pack P1 target verification failed for ${targets[sourceName]}`);
    }
  }

  rmSync(join(root, "packages", "education-mode-host", "package.json"), { force: true });
  for (const path of bootstrapPaths) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
