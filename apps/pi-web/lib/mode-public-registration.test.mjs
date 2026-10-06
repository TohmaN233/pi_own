import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { qualifyModePublicRegistrations } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./mode-public-registration.ts");

function extension(path, toolNames = [], commandNames = []) {
  return {
    path,
    tools: new Map(toolNames.map((name) => [name, { definition: { name, label: name }, sourceInfo: {} }])),
    commands: new Map(commandNames.map((name) => [name, { name, handler() {} }])),
  };
}

test("same-session public tool and command collisions receive deterministic provider prefixes", () => {
  const first = extension("C:/runtime/node_modules/alpha-tools/index.ts", ["search"], ["inspect"]);
  const second = extension("C:/runtime/node_modules/beta-tools/index.ts", ["search"], ["inspect"]);
  const changes = qualifyModePublicRegistrations([first, second]);
  assert.deepEqual([...first.tools.keys()], ["alpha_tools_search"]);
  assert.deepEqual([...second.tools.keys()], ["beta_tools_search"]);
  assert.equal(first.tools.get("alpha_tools_search").definition.name, "alpha_tools_search");
  assert.equal(second.tools.get("beta_tools_search").definition.name, "beta_tools_search");
  assert.deepEqual([...first.commands.keys()], ["alpha_tools_inspect"]);
  assert.deepEqual([...second.commands.keys()], ["beta_tools_inspect"]);
  assert.equal(changes.length, 4);
});

test("host command keeps its name and late extension registration cannot silently shadow it", () => {
  const host = extension("<inline:host>", ["bash"]);
  const packageExtension = extension("C:/runtime/node_modules/worker/index.ts", ["bash"]);
  qualifyModePublicRegistrations([host, packageExtension]);
  assert.deepEqual([...host.tools.keys()], ["bash"]);
  assert.deepEqual([...packageExtension.tools.keys()], ["worker_bash"]);
  packageExtension.tools.set("bash", { definition: { name: "bash", label: "updated" }, sourceInfo: {} });
  assert.equal(packageExtension.tools.has("bash"), false);
  assert.equal(packageExtension.tools.get("worker_bash").definition.label, "updated");
  host.tools.set("inspect", { definition: { name: "inspect" }, sourceInfo: {} });
  packageExtension.tools.set("inspect", { definition: { name: "inspect" }, sourceInfo: {} });
  assert.equal(packageExtension.tools.has("inspect"), false);
  assert.equal(packageExtension.tools.get("worker_inspect").definition.name, "worker_inspect");
  packageExtension.tools.delete("inspect");
  assert.equal(packageExtension.tools.has("worker_inspect"), false);
});

test("two registrations from the same package still get distinct names", () => {
  const first = extension("C:/runtime/node_modules/worker/first.ts", ["search"]);
  const second = extension("C:/runtime/node_modules/worker/second.ts", ["search"]);
  qualifyModePublicRegistrations([first, second]);
  assert.deepEqual([...first.tools.keys()], ["worker_search"]);
  assert.deepEqual([...second.tools.keys()], ["worker_search_2"]);
});

test("compiled package extensions use their declared wrapper identity as the prefix", () => {
  const first = extension("C:/agent/mode-packs/packages/hash-a/module-runtime/extension-course-builder.mjs", ["search"]);
  const second = extension("C:/agent/mode-packs/packages/hash-b/module-runtime/extension-study-research.mjs", ["search"]);
  qualifyModePublicRegistrations([first, second]);
  assert.deepEqual([...first.tools.keys()], ["course_builder_search"]);
  assert.deepEqual([...second.tools.keys()], ["study_research_search"]);
});

test("a late host registration takes the bare name and moves an existing package registration", () => {
  const host = extension("<inline:host>");
  const worker = extension("C:/runtime/node_modules/worker/index.ts", ["inspect"]);
  qualifyModePublicRegistrations([host, worker]);
  host.tools.set("inspect", { definition: { name: "inspect" }, sourceInfo: {} });
  assert.equal(host.tools.has("inspect"), true);
  assert.equal(worker.tools.has("inspect"), false);
  assert.equal(worker.tools.get("worker_inspect").definition.name, "worker_inspect");
  worker.tools.set("inspect", { definition: { name: "inspect", label: "updated" }, sourceInfo: {} });
  assert.equal(worker.tools.get("worker_inspect").definition.label, "updated");
});

test("late qualified names avoid names registered earlier in the same session", () => {
  const first = extension("C:/runtime/node_modules/worker/first.ts");
  const second = extension("C:/runtime/node_modules/other/index.ts", ["search"]);
  const third = extension("C:/runtime/node_modules/worker/third.ts");
  qualifyModePublicRegistrations([first, second, third]);
  first.tools.set("worker_search", { definition: { name: "worker_search" }, sourceInfo: {} });
  third.tools.set("search", { definition: { name: "search" }, sourceInfo: {} });
  assert.equal(third.tools.has("worker_search"), false);
  assert.equal(third.tools.get("worker_search_2").definition.name, "worker_search_2");
});

test("flags and shortcuts fail explicitly instead of Pi silently choosing one provider", () => {
  const first = extension("C:/runtime/node_modules/alpha/index.ts");
  const second = extension("C:/runtime/node_modules/beta/index.ts");
  first.flags = new Map([["audit", { name: "audit" }]]);
  second.flags = new Map([["audit", { name: "audit" }]]);
  assert.throws(() => qualifyModePublicRegistrations([first, second]), /public flag registration conflict: audit/u);
  second.flags.clear();
  first.shortcuts = new Map([["Ctrl+K", { shortcut: "Ctrl+K" }]]);
  second.shortcuts = new Map([["ctrl+k", { shortcut: "ctrl+k" }]]);
  assert.throws(() => qualifyModePublicRegistrations([first, second]), /public shortcut registration conflict: ctrl\+k/u);
  first.flags.clear(); second.flags.clear(); first.shortcuts.clear(); second.shortcuts.clear();
  qualifyModePublicRegistrations([first, second]);
  first.flags.set("audit", { name: "audit" });
  assert.throws(() => second.flags.set("audit", { name: "audit" }), /public flag registration conflict: audit/u);
  first.shortcuts.set("Ctrl+K", { shortcut: "Ctrl+K" });
  assert.throws(() => second.shortcuts.set("ctrl+k", { shortcut: "ctrl+k" }), /public shortcut registration conflict: ctrl\+k/u);
});
