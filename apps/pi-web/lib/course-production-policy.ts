export const COURSE_PRODUCTION_WORKFLOW_ID = "course-production";
/** Product selection is a private Host action, independent of the graph ID. */
export const COURSE_PRODUCT_DEFINITIONS = {
  "course-lesson-artifacts": { kind: "bundle", title: "单课草案 + PDF/Rmd", scope: "lesson" },
  "course-slide-revision": { kind: "deck", title: "修改现有 Beamer", scope: "existing-deck" },
  "course-semester-plan": { kind: "semester", title: "学期计划", scope: "course" },
  "course-lesson-plan": { kind: "lesson", title: "单课计划", scope: "lesson" },
  "course-beamer-deck": { kind: "deck", title: "Beamer 课件", scope: "existing-lesson" },
  "course-teacher-notes": { kind: "teacher-notes", title: "教师讲稿 TeX/PDF", scope: "existing-deck" },
  "course-assignment-plan": { kind: "assignment-plan", title: "Assignment 计划", scope: "assignment" },
  "course-assignment-artifacts": { kind: "assignment-artifacts", title: "Assignment 学生 TeX / 解答 Rmd", scope: "assignment" },
  "course-rmd-lab": { kind: "rmd", title: "独立 Rmd 实验", scope: "course-or-lesson" },
  "course-interactive-html": { kind: "html", title: "独立交互 HTML", scope: "existing-lesson" },
  "course-material-analysis": { kind: "analysis", title: "分析课程资料", scope: "course" },
  "course-coverage-checkpoint": { kind: "checkpoint", title: "课次覆盖记录", scope: "existing-lesson" },
} as const;
export type CourseWorkflowProductAction = keyof typeof COURSE_PRODUCT_DEFINITIONS;
export type CourseProductionProduct = typeof COURSE_PRODUCT_DEFINITIONS[CourseWorkflowProductAction]["kind"];
export type CourseProductionOperation = "new" | "revise";
export const COURSE_PRODUCTION_PRODUCTS = [...new Set(Object.values(COURSE_PRODUCT_DEFINITIONS).map(item => item.kind))];
export const COURSE_PRODUCTION_BRANCHES = COURSE_PRODUCTION_PRODUCTS.flatMap(product => ["new", "revise"].map(operation => `${product}:${operation}`));
export function courseProductionRoute(action: CourseWorkflowProductAction, operation: CourseProductionOperation) {
  if (!Object.hasOwn(COURSE_PRODUCT_DEFINITIONS, action) || !["new", "revise"].includes(operation)) throw new Error("Invalid private Course production selection");
  const product = COURSE_PRODUCT_DEFINITIONS[action].kind;
  if (action === "course-slide-revision" && operation !== "revise") throw new Error("Slide revision requires an existing deck baseline");
  return { product, action, operation, branch: `${product}:${operation}`, kind: product.startsWith("assignment") ? "assignment" : product };
}
export const COURSE_PRODUCTION_ROUTE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["product", "action", "operation", "branch", "kind"],
  properties: { product: { enum: COURSE_PRODUCTION_PRODUCTS }, action: { enum: Object.keys(COURSE_PRODUCT_DEFINITIONS) },
    operation: { enum: ["new", "revise"] }, branch: { enum: COURSE_PRODUCTION_BRANCHES },
    kind: { enum: [...new Set(COURSE_PRODUCTION_PRODUCTS.map(product => product.startsWith("assignment") ? "assignment" : product))] } },
};
