import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {COURSE_BUILDER_DRAFT}=await jiti.import("./course-builder-pack.ts");
test("teacher defaults carry the Workflow bridge and pi-caw without retired shared pedagogy or production loop",()=>{
 assert.equal(COURSE_BUILDER_DRAFT.revision,24);
 assert.deepEqual(COURSE_BUILDER_DRAFT.components.map(({type,id})=>[type,id]),[["plugin","course-builder"],["skill","pi-caw"]]);
 assert.ok(COURSE_BUILDER_DRAFT.instructions.includes("Course Workflow migration: skill-retirement/v1"));
 assert.ok(COURSE_BUILDER_DRAFT.instructions.includes("Course Workflow migration: conditional-production/v2"));
 assert.ok(COURSE_BUILDER_DRAFT.systemPrompt.includes("course-production"));
 assert.ok(COURSE_BUILDER_DRAFT.systemPrompt.includes("productAction"));
 assert.doesNotMatch(COURSE_BUILDER_DRAFT.systemPrompt,/delivery_finish|save_teacher_notes|save_deck|save_lesson|save_assignment/);
});
