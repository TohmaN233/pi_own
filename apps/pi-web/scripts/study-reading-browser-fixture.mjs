import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

// Local engineering protocol server only. No external provider or academic evaluation.
const directory = resolve(process.env.PI_STUDY_FIXTURE_DIR || "../../.artifacts/study-research/reading-browser");
for (const folder of ["agent", "sessions", "data", "paper"]) mkdirSync(join(directory, folder), { recursive: true });
Object.assign(process.env, { PI_CODING_AGENT_DIR: join(directory, "agent"), PI_CODING_AGENT_SESSION_DIR: join(directory, "sessions"),
  PI_LEARNING_HARNESS_DIR: join(directory, "data"), PI_MODE_PACK_STORE_PATH: join(directory, "packs.json") });
writeFileSync(join(directory, "agent", "models.json"), JSON.stringify({ providers: { "study-local-fixture": {
  baseUrl: "http://127.0.0.1:30186/v1", api: "openai-completions", apiKey: "offline-fixture-only",
  models: [{ id: "reading-fixture", name: "Offline Study protocol fixture", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 20000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }, null, 2));
const observations = [];
const server = createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") throw new Error("Unsupported local fixture request");
    let bytes = 0; const chunks = [];
    for await (const part of request) { bytes += part.length; if (bytes > 1024 * 1024) throw new Error("Fixture request too large"); chunks.push(part); }
    const body = JSON.parse(Buffer.concat(chunks));
    const background = body.tools?.some((tool) => tool.function?.name === "study_task_report");
    const observation = { background, startedAt: new Date().toISOString(), model: body.model, toolNames: body.tools?.map((tool) => tool.function?.name) ?? [] };
    observations.push(observation);
    const last = body.messages.at(-1);
    let delta, finish;
    if (background && last.role !== "tool") {
      const user = body.messages.findLast((message) => message.role === "user");
      const text = typeof user.content === "string" ? user.content : user.content.map((item) => item.text ?? "").join("\n");
      const packet = JSON.parse(text.slice(text.indexOf('\n{"version"') + 1));
      const report = { summary: `离线工程报告：读取 ${packet.evidence.length} 个片段；不代表学术验收。`, status: "inconclusive", findings: [],
        notes: packet.evidence.length ? [{ title: "离线读取记录", body: "此笔记验证后台阅读与知识保存协议；论文内容仍需实际模型和用户理解验收。", evidenceIds: packet.evidence.map((item) => item.id) }] : [],
        unresolved: ["实际论文理解质量未在此离线工程夹具中评价。"] };
      observation.purpose=packet.purpose;
      if(packet.version===2&&packet.purpose==='paper-map'){
        report.summary='离线工程全文地图：仅验证报告归约协议，未经学术验收。';
        report.paperMap={problem:'工程夹具讨论一阶和二阶矩条件的区别。',contributions:'归约已有分段报告；不代替实际论文贡献判断。',assumptionsNotation:'X 的有限期望不意味着有限方差。',argumentDependencies:'条件、结论和先前分段报告通过不可变哈希关联。',limitationsUnresolved:'内容为离线合成报告，实际推导与论文理解仍未核查。'};
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5000));
      delta = { role: "assistant", tool_calls: [{ index: 0, id: `report-${observations.length}`, type: "function", function: { name: "study_task_report", arguments: JSON.stringify(report) } }] };
      finish = "tool_calls";
    } else {
      const latestUser=body.messages.findLast(message=>message.role==='user');
      const userText=typeof latestUser?.content==='string'?latestUser.content:Array.isArray(latestUser?.content)?latestUser.content.map(item=>item.text??'').join('\n'):'';
      const assignment=body.tools?.some(tool=>tool.function?.name==='study_assignment')&&userText.includes('requestId:');
      const resultReading=body.tools?.some(tool=>tool.function?.name==='study_paper')&&userText.includes('action=read_result');
      let assignmentCall=null;
      if(assignment&&last.role!=='tool') {
        const requestId=/requestId: ([^\s]+)/.exec(userText)?.[1],phase=/phaseRevision: ([0-9]+)/.exec(userText)?.[1];
        if(!requestId||!phase)throw new Error('Malformed explicit Assignment fixture request');
        assignmentCall={action:'read-request',requestId,expectedPhaseRevision:Number(phase)};
      } else if(assignment&&last.role==='tool') {
        const record=JSON.parse(last.content);
        if(record.request&&record.draft===null){
          const n=record.request.count??2;
          assignmentCall={action:'save-draft',requestId:record.request.requestId,expectedPhaseRevision:record.request.phaseRevision,expectedProjectRevision:record.request.projectRevision,expectedRequestRevision:record.request.revision,expectedDraftRevision:0,draft:{overview:'离线 Assignment 协议夹具，不代表学术出题质量。',tasks:Array.from({length:n},(_,i)=>`工程测试问题 ${i+1}：当前来源身份是什么？`),solutionNotes:Array.from({length:n},()=>`冻结来源：${record.originSources[0].sourceId}`),deliverables:[],rubric:[],materialIds:record.originSources.map(s=>s.sourceId)}};
        }
      }
      if(resultReading&&last.role!=='tool') {
        const resultId=/resultId="([^"]+)"/.exec(userText)?.[1],revision=/expectedResultRevision=([0-9]+)/.exec(userText)?.[1];
        if(!resultId||!revision)throw new Error('Malformed bounded result fixture prompt');
        const call={action:'read_result',resultId,expectedResultRevision:Number(revision),field:'analysis',textOffset:0,textLimit:1000};
        observation.resultRead=call;observation.promptChars=userText.length;
        delta={role:'assistant',tool_calls:[{index:0,id:`result-read-${observations.length}`,type:'function',function:{name:'study_paper',arguments:JSON.stringify(call)}}]};finish='tool_calls';
      }
      else if(assignmentCall){observation.assignmentAction=assignmentCall.action;delta={role:'assistant',tool_calls:[{index:0,id:`assignment-${observations.length}`,type:'function',function:{name:'study_assignment',arguments:JSON.stringify(assignmentCall)}}]};finish='tool_calls';}
      else {delta = { role: "assistant", content: background ? "离线报告已保存。" : "前台对话仍可立即响应；这是离线协议测试回复。" }; finish = "stop";}
      if(resultReading&&last.role==='tool') {const field=JSON.parse(last.content);if(field.available!==true||typeof field.content!=='string'||field.content.length>1000||!field.contentHash)throw new Error('Bounded result tool receipt invalid');observation.resultField={identity:field.identity,contentChars:field.content.length,contentHash:field.contentHash,available:field.available};}
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta, finish_reason) => ({ id: `fixture-${observations.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model,
      choices: [{ index: 0, delta, finish_reason }] });
    response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, finish))}\n\n`);
    response.end("data: [DONE]\n\n");
    observation.finishedAt = new Date().toISOString();
    writeFileSync(join(directory, "local-model-observations.json"), JSON.stringify(observations, null, 2));
  } catch (error) { console.error("[local-reading-fixture]", error); response.writeHead(500); response.end(String(error)); }
});
await new Promise((ready, reject) => { server.once("error", reject); server.listen(30186, "127.0.0.1", ready); });
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getLearningHarness } = await jiti.import("../lib/harness-server.ts");
const { ModePackStore } = await jiti.import("../lib/mode-pack-store.ts");
const { reviseModePackSettings } = await jiti.import("../../../packages/profile-resource-host/src/index.ts");
const { sha256Hex, contentHash } = await jiti.import("../../../packages/harness-core/src/index.ts");
const { studyVisualRuntimeIdentity } = await jiti.import("../lib/study-visual-sandbox.ts");
const rpc = await jiti.import("../lib/rpc-manager.ts");
const harness = getLearningHarness(), cwd = join(directory, "paper");
try {
  if (process.env.PI_STUDY_FIXTURE_REUSE === "1") {
    const seed = JSON.parse(readFileSync(join(directory, "seed.json"), "utf8"));
    console.info("Existing local reading fixture ready", { ...seed, port: 30186 });
  } else {
  const resolved = await new ModePackStore().resolve("study-research.study", cwd);
  const snapshot = reviseModePackSettings(resolved.snapshot, { provider: "study-local-fixture", model: "reading-fixture", thinkingLevel: "off" }, resolved.inventory.catalog);
  const projectId = `reading-browser-${Date.now()}`;
  harness.projectWorkspaces.create({ id: projectId, title: "后台阅读 · 离线协议验收", cwd, defaults: snapshot, courseProjectId: null });
  const sessionId = rpc.createPersistedGenericSession(cwd, "原始论文学习对话", snapshot);
  harness.projectWorkspaces.move(sessionId, projectId);
  const phase = harness.studyResearch.bindSession(projectId, sessionId, "study");
  const scope = { projectId, sessionId, expectedPhaseRevision: phase.revision };
  const chunks = Array.from({ length: 9 }, (_, index) => ({ ordinal: index + 1, locator: JSON.stringify({ kind: "tex-lines", startLine: index + 1, endLine: index + 1 }),
    text: `Section ${index + 1}: finite expectation and finite variance are different assumptions. This is synthetic engineering fixture text.` }));
  const text = chunks.map((chunk) => chunk.text).join("\n"); writeFileSync(join(cwd, "paper.tex"), text);
  harness.studyResearch.registerSource(scope, { sourceRoot: cwd, relativePath: "paper.tex", kind: "tex", sourceRole: "primary", diagnostics: [],
    contentHash: `sha256:${sha256Hex(text)}`, parser: "offline-fixture-v1", chunks }, 0);
  if (process.env.PI_STUDY_FIXTURE_DIR) {
    harness.studyResearch.createVisualizationDraft(scope, {
      creatorContextId: harness.studyResearch.registerTrustedRunnerContext(scope, `pi-session:${sessionId}`).contextId,
      purpose: "独立审查流程测试草稿 · 不作学术结论",
      code: 'return {elements:[{tag:"circle",attrs:{cx:inputs.x,cy:200,r:40,fill:"#326b8e"}}],summary:"工程测试草稿"}',
      inputs: { x: 150 }, inputHashes: {}, environmentHash: contentHash(studyVisualRuntimeIdentity()),
    }, harness.studyResearch.projectRevision(scope).revision);
  }
  writeFileSync(join(directory, "seed.json"), JSON.stringify({ directory, projectId, sessionId }, null, 2));
  console.info("Local reading fixture ready", { projectId, sessionId, port: 30186 });
  }
} finally { harness.close(); globalThis.__piLearningHarness = undefined; }
