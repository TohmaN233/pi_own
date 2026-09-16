import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createWriteTool, createPowerShellTool, createBashTool } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { CourseBuilderHost, runCourseBuilderCommand } = await jiti.import("../../../packages/course-builder-host/src/index.ts");
const { importCourseGeneratedAsset } = await jiti.import("./course-builder-generated-assets.ts");
const { COURSE_BUILDER_DRAFT } = await jiti.import("./course-builder-pack.ts");
const { createDefaultCourseBuilderProject } = await jiti.import("./course-builder-defaults.ts");

test("teacher defaults expose native source authoring and a terminal", () => {
  for (const name of ["read", "write", "edit", "bash"]) assert.ok(COURSE_BUILDER_DRAFT.tools.includes(name), name);
});

test("native write and terminal knit real R Markdown, import its PNG and patch/compile the existing deck", {skip: !process.env.PI_TEST_RSCRIPT || process.env.PI_TEST_XELATEX !== "1", timeout:120000}, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-generated-chain-"));
  const db = new DatabaseSync(":memory:"), host = new CourseBuilderHost(db);
  try {
    const project = host.createProject({...createDefaultCourseBuilderProject(),courseId:"computed-figures",title:"Computed figures",weeks:1,language:"English"});
    host.bindSession("teacher",project.projectId);
    const semester = host.saveSemesterPlan("teacher",{title:"Plan",rationale:"Predict then compute",sessions:[{week:1,session:1,title:"Plots",objectives:["Explain a plot"],prerequisites:[],topics:["Plots"],materialIds:[],activities:["Predict"],understandingEvidence:["Explain axes"],assessment:null,homework:null,courseGoalsCovered:project.goals,revisits:[],visualOpportunities:[]}]},0);
    host.reviewSemesterPlan("teacher",semester.semesterPlanId,1,"approve","Teacher fixture approval");
    const lesson = host.saveLessonPlan("teacher",{week:1,session:1,title:"Plots",objectives:["Explain a plot"],prerequisites:[],misconceptions:[],segments:[{minutes:50,title:"Plot",teacherAction:"Demonstrate",learnerAction:"Explain",checkForUnderstanding:"Predict"}],examples:["Quadratic"],exercises:["Compare slopes"],materialIds:[],visualRequests:[],notes:[]},0,1);
    host.reviewLessonPlan("teacher",lesson.lessonPlanId,1,"approve","Teacher fixture approval");
    const source = String.raw`\documentclass[aspectratio=169,11pt]{beamer}
\begin{document}
\begin{frame}{Preserved explanation}
A square function maps each input to its square. Predict which values grow most quickly before examining the computed plot.
\end{frame}
\begin{frame}{Computed plot}
The computed figure will be inserted here.
\end{frame}
\end{document}`;
    const deck = host.saveBeamerDeck("teacher",{lessonPlanId:lesson.lessonPlanId,title:"Plots",source,frameOutline:["Preserved explanation","Computed plot"],assetMaterialIds:[]},0,1);
    const directory = join(cwd,".pi","course-builder",project.projectId,"lesson-1");
    const sourcePath = join(directory,"plot.Rmd"), imagePath = join(directory,"plot.png");
    const rmd = '# Computed quadratic\n\n```{r}\npng("plot.png", width=900, height=600)\nx <- seq(-2, 2, length.out=101)\nstopifnot(length(x) == 101)\nplot(x, x^2, type="l", xlab="Input x", ylab="Square of x")\ndev.off()\n```\n';
    await createWriteTool(cwd).execute("write-rmd",{path:sourcePath,content:rmd});
    assert.equal(readFileSync(sourcePath,"utf8"),rmd);
    const runner = join(directory,"render.R");
    await createWriteTool(cwd).execute("write-runner",{path:runner,content:'knitr::knit("plot.Rmd", output="plot.md", quiet=TRUE)\nstopifnot(file.exists("plot.png"), file.info("plot.png")$size > 1000)\ncat("RMD_EXECUTED_OK\\n")\n'});
    const quote = value => "'" + value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''") + "'";
    const terminal = process.platform === "win32" ? createPowerShellTool(directory) : createBashTool(directory);
    const command = `${process.platform === "win32" ? "& " : ""}${quote(process.env.PI_TEST_RSCRIPT)} ${quote(runner)}`;
    const run = await terminal.execute("execute-rmd",{command,timeout:60});
    assert.match(run.content.map(c=>c.text??"").join("\n"),/RMD_EXECUTED_OK/);
    const execute = command => runCourseBuilderCommand(host,"teacher",command,{trustedTex:true,importGeneratedAsset:(spec,revision)=>importCourseGeneratedAsset(host,"teacher",cwd,spec,revision)});
    const imported = await execute({action:"import_generated_asset",expectedRevision:host.getProjectForSession("teacher").revision,spec:{path:imagePath,sourcePath,lessonPlanId:lesson.lessonPlanId,purpose:"R-generated quadratic plot"}});
    assert.deepEqual(Buffer.from(host.getMaterialBytes("teacher",imported.materialId)),readFileSync(imagePath));
    const image = host.getMaterial("teacher",imported.materialId);
    const assetPath = imported.beamerPath;
    assert.equal(assetPath,`assets/${image.materialId}.${image.name.split('.').at(-1)}`);
    const replacement = String.raw`\includegraphics[width=.8\textwidth,height=.7\textheight,keepaspectratio]{${assetPath}}`;
    const patched = await execute({action:"patch_deck",id:deck.deckId,expectedRevision:1,parentRevision:1,draft:{edits:[{oldText:"The computed figure will be inserted here.",newText:replacement}],addAssetMaterialIds:[imported.materialId]}});
    assert.equal(patched.deckId,deck.deckId);
    assert.equal(host.getSnapshotForSession("teacher").decks[0].source,source.replace("The computed figure will be inserted here.",replacement));
    const compiled = await execute({action:"compile",id:deck.deckId,expectedRevision:2});
    assert.equal(compiled.succeeded,true,JSON.stringify(compiled));
    assert.ok(compiled.pdfHash);
    const review = await execute({action:"review_deck",id:deck.deckId});
    assert.equal(review.status,"pass",JSON.stringify(review));
  } finally {
    db.close();
    assert.ok(resolve(cwd).startsWith(resolve(tmpdir()) + sep + "pi-generated-chain-"));
    rmSync(cwd,{recursive:true});
  }
});
