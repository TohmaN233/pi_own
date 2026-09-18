import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("an existing generic conversation moves into a course only after Course Builder activation", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-project-course-move-"));
	const cwd = join(root, "workspace");
	const skills = join(root, "skills");
	mkdirSync(cwd);
	cpSync(new URL("../../../skills/", import.meta.url), skills, { recursive: true });
	const env = {
		PI_SKILLS_DIR: skills,
		PI_LEARNING_HARNESS_DIR: join(root, "harness"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_MODE_PACK_STORE_PATH: join(root, "mode-packs.json"),
		ANTHROPIC_API_KEY: "offline-fixture-no-provider-request",
	};
	const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
	const rpc = await jiti.import("./rpc-manager.ts");
	const { getLearningHarness } = await jiti.import("./harness-server.ts");
	const { createDefaultCourseBuilderProject } = await jiti.import("./course-builder-defaults.ts");
	const { moveProjectConversation } = await jiti.import("./project-workspaces-service.ts");
	t.after(async () => {
		for (const wrapper of globalThis.__piSessions?.values() ?? []) await wrapper.shutdown();
		globalThis.__piLearningHarness?.close();
		globalThis.__piLearningHarness = undefined;
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	const sessionId = rpc.createPersistedGenericSession(cwd, "Existing discussion");
	const initial = await rpc.getGenericModePackStatus(sessionId);
	assert.equal(initial.runtime.binding, null);
	const harness = getLearningHarness();
	const course = harness.courseBuilder.createProject(createDefaultCourseBuilderProject());
	const moved = await moveProjectConversation(sessionId, course.projectId);

	assert.equal(moved.href, `/course-builder?sessionId=${encodeURIComponent(sessionId)}`);
	assert.equal(harness.courseBuilder.getProjectForSession(sessionId)?.projectId, course.projectId);
	assert.equal(harness.projectWorkspaces.members().find((item) => item.sessionId === sessionId)?.projectId, course.projectId);
	const activated = await rpc.getGenericModePackStatus(sessionId);
	assert.equal(activated.runtime.verified, true);
	assert.equal(activated.runtime.binding?.snapshot.profileId, "course-builder");
});
