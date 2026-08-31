import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createExercisePrivate } from "../packages/assessment-host/src/index.ts";
import { PdftotextExtractor } from "../packages/course-host/src/index.ts";
import { LearningHarness } from "../packages/learning-harness/src/index.ts";
import { createS4Ci3DemoExercises } from "./fixtures/assessment-demo-seed.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const defaultDataDirectory = join(repositoryRoot, ".learning-harness-data");
const defaultZipPath = join(dirname(repositoryRoot), "S4CI3 F2022 Lecture Notes.zip");
const webRequire = createRequire(join(repositoryRoot, "apps", "pi-web", "package.json"));
const { SessionManager } = await import(
  pathToFileURL(join(repositoryRoot, "apps", "pi-web", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href,
);

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function findReopenableSessionFile(sessionDirectory, sessionId) {
  const files = await readdir(sessionDirectory, { withFileTypes: true });
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
    const sessionFile = join(sessionDirectory, file.name);
    const manager = SessionManager.open(sessionFile, sessionDirectory);
    if (manager.getSessionId() !== sessionId) continue;
    const hasHarnessJournal = manager.getBranch().some(
      (entry) => entry.type === "custom" && entry.customType === "learning-harness:runtime-journal/v1",
    );
    if (!hasHarnessJournal) throw new Error(`Demo Pi session ${sessionId} has no persisted Harness journal`);
    return sessionFile;
  }
  throw new Error(`Demo Pi session ${sessionId} has no reopenable JSONL file in ${sessionDirectory}`);
}

async function materializeNewSessionJournal(manager) {
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Demo Pi session has no persistence path");
  const header = manager.getHeader();
  if (!header) throw new Error("Demo Pi session has no header to materialize");
  const entries = manager.getEntries();
  if (!entries.some((entry) => entry.type === "custom" && entry.customType === "learning-harness:runtime-journal/v1")) {
    throw new Error("Demo Pi session has no Harness journal to materialize");
  }
  await writeFile(sessionFile, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx" });
}

function lookupExistingDemo(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare("SELECT key, value FROM learning_harness_state WHERE key IN ('course-host', 'sessions')").all();
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const courseState = JSON.parse(values.get("course-host"));
    const sessionState = JSON.parse(values.get("sessions"));
    const course = courseState?.versions?.find((value) => value?.courseId === courseId);
    if (!course?.courseVersionId) throw new Error(`No seeded demo course ${courseId} exists in ${databasePath}`);
    const session = sessionState?.sessions?.find((value) => value?.binding?.courseVersionId === course.courseVersionId);
    if (!session?.sessionId) throw new Error(`No seeded demo session for ${course.courseVersionId} exists in ${databasePath}`);
    return { courseVersionId: course.courseVersionId, sessionId: session.sessionId };
  } finally {
    database.close();
  }
}

const dataDirectory = option("--data-dir") || process.env.PI_LEARNING_HARNESS_DIR || defaultDataDirectory;
const zipPath = option("--zip") || defaultZipPath;
const databasePath = join(dataDirectory, "learning-harness.sqlite");
const agentDirectory = process.env.PI_CODING_AGENT_DIR || join(dataDirectory, "pi-agent");
const courseId = "s4ci3-f2022-demo";
if (process.argv.includes("--lookup-only")) {
  process.stdout.write(`${JSON.stringify(lookupExistingDemo(databasePath))}\n`);
} else {
  await mkdir(dataDirectory, { recursive: true });
  const harness = new LearningHarness({ databasePath });
  try {
    let course = harness.listCourses().find((item) => item.courseId === courseId);
    if (!course) {
      const JSZip = webRequire("jszip");
      const archive = await JSZip.loadAsync(await readFile(zipPath));
      const materials = await Promise.all(
        Object.values(archive.files)
          .filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith(".pdf"))
          .sort((left, right) => left.name.localeCompare(right.name))
          .map(async (entry) => ({
            name: entry.name,
            kind: "pdf",
            mediaType: "application/pdf",
            content: new Uint8Array(await entry.async("uint8array")),
          })),
      );
      if (materials.length === 0) throw new Error(`No PDF materials found in ${zipPath}`);
      course = await harness.publishCourseVersion(courseId, materials, {
        pdfTextExtractor: new PdftotextExtractor(process.env.PI_PDFTOTEXT_PATH || "pdftotext"),
      });
    }
    for (const exercise of createS4Ci3DemoExercises(course.courseVersionId, createExercisePrivate)) {
      harness.seedCourseExercise(exercise.public, exercise.private);
    }
    let session = harness.findStudentSessionForCourse(course.courseVersionId);
    const sessionDirectory = join(agentDirectory, "sessions");
    if (!session) {
      const manager = SessionManager.create(repositoryRoot, sessionDirectory);
      session = harness.openStudentSession({ sessionStore: manager, courseVersionId: course.courseVersionId });
      await materializeNewSessionJournal(manager);
    }
    const sessionFile = await findReopenableSessionFile(sessionDirectory, session.sessionId);
    process.stdout.write(`${JSON.stringify({ courseVersionId: course.courseVersionId, sessionId: session.sessionId, sessionFile })}\n`);
  } finally {
    harness.close();
  }
}
