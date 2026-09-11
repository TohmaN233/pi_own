import { identifier, StudyError } from "../../../packages/study-research-host/src/index.ts";
import { getLearningHarness } from "./harness-server";
import { getGenericModePackStatus, getRpcSession } from "./rpc-manager";
import { requireStudyWorkspace } from "./study-research-service";
import { requireCourseBuilderWorkspace } from "./course-builder-request";

/** Scope is derived from durable bindings, never from a model/user supplied project ID. */
export async function mathVisualizationContext(sessionId: string, liveRequired = false) {
  identifier(sessionId);
  const status = await getGenericModePackStatus(sessionId);
  const snapshot = status.runtime.binding?.snapshot;
  if (!snapshot?.resources.some((resource) => resource.enabled && resource.kind === "extension" && resource.id === "math-visualization")) throw new StudyError("VISUAL_DISABLED", "Activate a Mode Pack containing the shared math plugin");
  const wrapper = getRpcSession(sessionId);
  if (liveRequired && (!wrapper?.isAlive() || !status.runtime.verified)) throw new StudyError("RUNTIME_REQUIRED", "Math tool requires the verified current Pi runtime");
  const harness = getLearningHarness();
  if (snapshot.profileId === "study-research") {
    await requireStudyWorkspace(sessionId);
    return { scope: `study:${harness.studyResearch.projectForSession(sessionId).id}`, snapshotId: snapshot.resourceSnapshotId, wrapper };
  }
  if (snapshot.profileId === "course-builder") {
    await requireCourseBuilderWorkspace(sessionId);
    const project = harness.courseBuilder.getProjectForSession(sessionId);
    if (!project) throw new StudyError("PROJECT_REQUIRED", "Create or open a course first");
    const assignmentId = harness.courseBuilder.getAgentAssignmentScope(sessionId);
    return { scope: `course:${project.projectId}:${assignmentId ?? "course"}`, snapshotId: snapshot.resourceSnapshotId, wrapper };
  }
  throw new StudyError("VISUAL_SCOPE_UNSUPPORTED", "The shared math plugin currently supports Course Builder and Study & Research");
}
export const mathVisualizationHost = () => getLearningHarness().mathVisualization;
export const MATH_VISUAL_SCHEMA = {
  common: { title: "plain text", purpose: "prediction, manipulation, observation and limits", xLabel: "x", yLabel: "y" },
  polynomial: { kind: "polynomial", title: "Quadratic", purpose: "Predict the sign, then inspect the curve", xLabel: "x", yLabel: "f(x)", coefficients: [0, 0, 1], domain: [-3, 3], samples: 101 },
  matrix2d: { kind: "matrix2d", title: "Linear transform", purpose: "Compare the original and transformed unit squares", xLabel: "x", yLabel: "y", matrix: [[1, 1], [0, 1]] },
  surface3d: { kind: "surface3d", title: "Saddle", purpose: "Rotate and compare sections along x and y", xLabel: "x", yLabel: "y", zLabel: "z", shape: "saddle", scale: 1, domain: [-2, 2], samples: 33 },
  scatter2d: { kind: "scatter2d", title: "Data", purpose: "Observe association, not causation", xLabel: "x", yLabel: "y", points: [[0, 0], [1, 1]] },
  scatter3d: { kind: "scatter3d", title: "3D data", purpose: "Rotate to reveal projection effects", xLabel: "x", yLabel: "y", zLabel: "z", points: [[0, 0, 0], [1, 1, 2]] },
  limits: "Unknown fields rejected. Polynomial coefficients ascending powers (1..9), samples 5..513; surface shape saddle|paraboloid|gaussian, samples 5..65; scatter <=4096 points; finite numeric values only. No JavaScript, functions, external URLs, user HTML or free Plotly configs.",
};
