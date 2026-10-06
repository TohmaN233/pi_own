import { STUDY_WORKFLOW_AUTHOR_SCHEMA } from "./study-workflow-domain";
import { canonical, record } from "./workflow-domain-data";
const optionalRecord=(value:unknown)=>value === undefined ? {} : record(value);
const empty=(value:unknown)=>value === undefined || Array.isArray(value) && value.length === 0;
function assert(condition:unknown,message:string):asserts condition{if(!condition)throw new Error(`Study Workflow closure denied: ${message}`);}
/** Authoritative pinned graph only; node names are compiler decisions, never a security identity. */
export function assertStudyExplanationGraph(value:unknown):string{
  const graph=record(value), policy=optionalRecord(graph.skill_policy), requirements=optionalRecord(graph.requirements);assert(graph?.id==="study-explanation"&&policy.mode==="strict"&&policy.implicit==="deny"&&Array.isArray(policy.ambient_allow)&&policy.ambient_allow.length===0,"Strict source-only explanation required");
  const requiredTools=requirements.tools;
  assert(Array.isArray(requiredTools)&&requiredTools.length===2&&new Set(requiredTools).size===2&&requiredTools.every(tool=>["study_task_context","study_response_commit"].includes(tool)),"Only the two registered Study Host tools may be declared");
  assert(["mcp_servers","executables","environment"].every(key=>empty(requirements[key])),"No MCP, executable or environment dependencies allowed");
  assert(Array.isArray(graph.nodes)&&graph.nodes.length===5&&Array.isArray(graph.edges)&&graph.edges.length===4,"Exactly one sequential context/author/commit pipeline required");
  const nodes=graph.nodes.map(record),edges=graph.edges.map(record);
  const start=nodes.find((node)=>node.type==="start"),end=nodes.find((node)=>node.type==="end"),agents=nodes.filter((node)=>node.type==="agent"),tools=nodes.filter((node)=>node.type==="tool");assert(start&&end&&agents.length===1&&tools.length===2,"No extra Role, Main, subworkflow, gate, condition or native task batch allowed");
  const author=agents[0],context=tools.find((node)=>optionalRecord(node.executor).tool==="study_task_context"),commit=tools.find((node)=>optionalRecord(node.executor).tool==="study_response_commit");assert(context&&commit&&record(context.executor).kind==="tool"&&record(commit.executor).kind==="tool","Exact attested Study Host tools required");
  assert(optionalRecord(author.executor).kind==="provider"&&typeof optionalRecord(author.executor).provider_id==="string"&&author.access==="read_only"&&!author.fanout&&(author.subagent_count === undefined || author.subagent_count === "auto" || author.subagent_count === 1)&&!author.skill_ref&&!author.subworkflow,"One independently bound readonly provider required");
  for(const node of nodes){assert(!node.skill_policy||(record(node.skill_policy).mode==="strict"&&record(node.skill_policy).implicit==="deny"&&empty(record(node.skill_policy).ambient_allow)),"Node cannot weaken Strict isolation");assert(empty(node.tools)&&empty(node.required_mcp_servers)&&empty(optionalRecord(node.requirements).mcp_servers),"Node cannot add native tools or MCP");assert(typeof node.id === "string" && node.id &&nodes.filter((other)=>other.id===node.id).length===1,"Unique compiler node IDs required");}
  assert(canonical(author.outputs_schema)===canonical(STUDY_WORKFLOW_AUTHOR_SCHEMA),"Author must emit only the bounded semantic answer");
  assert(canonical(context.input_bindings)===canonical({taskId:"/inputs/taskId"}),"Context task must bind directly from Host Root");
  assert(canonical(commit.input_bindings)===canonical({taskId:"/inputs/taskId",requestId:"/inputs/requestId",bindingSha256:`/nodes/${context.id}/output/bindingSha256`,answer:`/nodes/${author.id}/output/answer`}),"Commit must bind Host identities beside the semantic answer");
  assert(Object.values(optionalRecord(author.input_bindings)).every(binding=>binding==="/inputs/question"||binding===`/nodes/${context.id}/output/context`)&&Object.values(optionalRecord(author.input_bindings)).includes("/inputs/question")&&Object.values(optionalRecord(author.input_bindings)).includes(`/nodes/${context.id}/output/context`),"Author receives only current question and scoped context");
  const chain=[start.id,context.id,author.id,commit.id,end.id];assert(chain.slice(1).every((target,index)=>edges.some((edge)=>edge.source===chain[index]&&edge.target===target&&!edge.condition)),"No branching or implicit execution allowed");
  const failures=optionalRecord(commit.completion_contract).fail_on_false;
  assert(optionalRecord(graph.finalization).required===true&&optionalRecord(graph.finalization).node_id===commit.id&&(Array.isArray(failures) && failures.includes("succeeded")),"Successful Host response is the exact finalizer");assert(typeof commit.id === "string", "Commit node ID required");return commit.id;
}
