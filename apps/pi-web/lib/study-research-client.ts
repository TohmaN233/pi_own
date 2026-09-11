import type { StudyResearchHost, StudyProject } from "../../../packages/study-research-host/src/index.ts";
export type StudyState = ReturnType<StudyResearchHost["state"]>;
export interface StudyListing { projects: StudyProject[]; bindings: {sessionId:string;projectId:string}[]; codeEnabled:boolean }
export interface StudyResponse { state:StudyState; codeEnabled:boolean }
export async function studyRequest<T>(payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/study-research',{method:'POST',headers:{'Content-Type':'application/json','x-study-user':'1'},body:JSON.stringify(payload),signal});
  const data = await response.json();
  if(!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data as T;
}
export async function studyState(sessionId:string, signal?:AbortSignal):Promise<StudyResponse> {
  const response=await fetch(`/api/study-research?sessionId=${encodeURIComponent(sessionId)}`,{cache:'no-store',signal});
  const data=await response.json();if(!response.ok)throw new Error(data.error ?? '读取学习项目失败');return data;
}
