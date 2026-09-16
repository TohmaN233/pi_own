import JSZip from "jszip";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { sha256Hex } from "../../../packages/harness-core/src/index.ts";
import { compileStudyCellProgram } from "../../../packages/study-execution-host/src/cell-program.ts";
import { decodeFrozenInput } from "../../../packages/study-execution-host/src/execution-payloads.ts";
import { createNativeWindowsCellAdapters } from "../../../packages/study-execution-host/src/cell-native-adapters.ts";
import { getLearningHarness } from "./harness-server";
import { studyContext, studyWorkspaceState } from "./study-research-service";
import { studyExecutionState, studyExecutionArtifacts, readStudyExecutionArtifact } from "./study-execution-service";
import { exportStudyGraph, exportStudyNotes } from "./study-export";
import { paperMapState } from "./study-paper-map";
import { contentHash } from "../../../packages/harness-core/src/index.ts";
import { studyVisualRuntimeIdentity } from "./study-visual-sandbox";

export async function exportStudyProject(sessionId: string, queueJobId?: string) {
  const context=await studyContext(sessionId);const state=await studyWorkspaceState(sessionId);
  const execution=await studyExecutionState(sessionId);const harness=getLearningHarness();
  const directory=resolve(process.env.PI_LEARNING_HARNESS_DIR||join(getAgentDir(),"learning-harness"));
  const coordinator=harness.createStudyExecutionCoordinator({artifactDirectory:join(directory,"study-execution-observations"),
    adapters:createNativeWindowsCellAdapters({runRootDirectory:join(directory,"study-executions"),cpuRatePercent:100})});
  const zip=new JSZip();let bytes=0;const hashes:Record<string,string>={};
  const add=(path:string,body:string|Uint8Array)=>{
    if(path.includes("\\")||path.split("/").some((part)=>!part||part==="."||part===".."||/[\0-\x1f:]/u.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)))throw new Error("Export contains a nonportable path");
    const data=typeof body==="string"?Buffer.from(body,"utf8"):body;bytes+=data.byteLength;
    if(bytes>96*1024*1024)throw new Error("Export exceeds 96 MiB; select one experiment to export separately");
    if(zip.file(path))throw new Error("Export path collision");zip.file(path,data);hashes[path]=`sha256:${sha256Hex(data)}`;
  };
  const json=(path:string,value:unknown)=>add(path,JSON.stringify(value,null,2)+"\n");
  add("notes.md",exportStudyNotes(state));json("graph.json",exportStudyGraph(state));
  const allSources=context.host.listSources(context.scope);
  json("sources.json",allSources.map(({sourceRoot:_root,...source})=>source));
  json("research/plans.json",context.host.listResearchPlans(context.scope));json("research/results.json",context.host.listResults(context.scope));
  json("research/reviews.json",context.host.listIndependentReviews(context.scope));
  json("visualizations/drafts.json",state.visualizations);
  json("learning/paper-maps.json",paperMapState(harness,context.scope.projectId,sessionId));
  json("visualizations/checks.json",state.visualizations.map(visual=>harness.studyTeaching.visualGate(context.scope,visual.visualizationId,contentHash(studyVisualRuntimeIdentity()))));
  const runs=execution.runs.filter((run)=>!queueJobId||run.queueJobId===queueJobId);
  if(queueJobId&&runs.length===0)throw new Error("Experiment was not found in this project");
  const index:string[]=[];
  for(const run of runs){
    const folder=`experiments/${run.taskId}`;const snapshot=harness.studyCells.readRun(context.scope,run.taskId);
    json(`${folder}/record.json`,{...run,cell:snapshot.cell,manifest:snapshot.manifest});
    index.push(`- [${snapshot.cell.title.replace(/[\r\n\[\]]/gu," ")}](./${folder}/README.md) — ${run.status}`);
    const settled=["succeeded","failed","cancelled","limit-reached"].includes(run.status);
    // Build readable instructions separately from code; exports never execute a program.
    if(settled){
      const payload=coordinator.readFrozenPayloadForTrustedExport(context.scope,run.queueJobId);
      const inputs=payload.inputs.map((input,index)=>({name:input.name,fileName:`input-${index+1}-${input.name.slice(0,100)}`}));
      payload.inputs.forEach((input,index)=>add(`${folder}/${inputs[index].fileName}`,decodeFrozenInput(input)));
      const compiled=compileStudyCellProgram({language:snapshot.cell.language,code:payload.program.content,parameters:JSON.parse(payload.parameters.canonicalJson),inputs});
      add(`${folder}/${compiled.fileName}`,compiled.program);add(`${folder}/source.${snapshot.cell.language==="python"?"py":"R"}`,payload.program.content);
      json(`${folder}/parameters.json`,snapshot.cell.parameters);json(`${folder}/environment.json`,payload.environment);
      json(`${folder}/input-manifest.json`,inputs.map((input,index)=>({...input,sha256:payload.inputs[index].sha256})));
      add(`${folder}/stdout.log`,run.result?.logs.stdout??"");add(`${folder}/stderr.log`,run.result?.logs.stderr??"");
      const artifacts=await studyExecutionArtifacts(sessionId,run.queueJobId);
      for(const descriptor of artifacts){const artifact=await readStudyExecutionArtifact({sessionId,queueJobId:run.queueJobId,path:descriptor.path,sha256:descriptor.sha256});add(`${folder}/outputs/${descriptor.path}`,artifact.bytes);}
      json(`${folder}/output-manifest.json`,artifacts);
      add(`${folder}/README.md`,[`# ${snapshot.cell.title}`,"",`Process state: ${run.status}; scientific conclusions require separate review and user confirmation.`,"",
        "The exact source, parameters, input bytes and runtime file hashes are included. Environment binaries/packages are not redistributed. Original output is under outputs/; inspect stdout.log and stderr.log.",
        "program.py/program.R is the deterministic original adapter wrapper. If rerunning manually, use a separate output working directory. For R, set R_COMPAT_PROGRAM to the absolute exported program.R path before sourcing it. A manual rerun does not inherit Pi's isolation or resource limits.",
        "",`Input manifest: [input-manifest.json](input-manifest.json). Output manifest: [output-manifest.json](output-manifest.json). Frozen record: [record.json](record.json).`,""].join("\n"));
    }else add(`${folder}/README.md`,[`# ${snapshot.cell.title}`,"",`State ${run.status}: execution was unsettled when exported. Only the immutable cell and observed status are included; there is no completed-output claim.`,"See [record.json](record.json).",""].join("\n"));
  }
  const final=await studyContext(sessionId,context.scope.expectedPhaseRevision);
  if(final.scope.projectId!==context.scope.projectId)throw new Error("Conversation changed project during export");
  add("README.md",[`# ${state.project.title}`,"",`Exported ${new Date().toISOString()} from project revision ${state.revision}.`,"",
    "[Learning notes](notes.md) · [Knowledge graph](graph.json) · [Source versions](sources.json) · [Research results](research/results.json)","",
    "Drafts, negative results, failures and unknowns retain their recorded states. This archive does not certify proofs or numerical correctness. Original papers are referenced by version; experiment inputs are frozen copies. Review disagreements remain in research/reviews.json. Visualizations remain drafts unless independently accepted; no rendering/validation claim is added by export.","",...index,""].join("\n"));
  json("checksums.json",{algorithm:"SHA-256",files:hashes});
  return zip.generateAsync({type:"uint8array",compression:"DEFLATE",compressionOptions:{level:6}});
}
