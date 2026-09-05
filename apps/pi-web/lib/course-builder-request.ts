import { getGenericModePackStatus, getRpcSession } from "./rpc-manager";
import { assertCourseBuilderSession } from "./course-builder-service";

export async function requireCourseBuilderRuntime(sessionId: string, idle = false) {
 assertCourseBuilderSession(sessionId);
 const status=await getGenericModePackStatus(sessionId);
 const wrapper=getRpcSession(sessionId);
 if (!wrapper || !status.runtime.live || !status.runtime.verified || status.runtime.binding?.snapshot.profileId!=="course-builder") throw new Error("Activate Course Builder in a live ordinary Pi session first");
 if(idle && status.runtime.busy) throw new Error("Session is busy; wait before teacher changes");
 return {wrapper,status};
}
export async function readCourseBuilderJson(request: Request): Promise<Record<string,unknown>> {
 const reader=request.body?.getReader(); if(!reader)throw new Error("Missing JSON body");
 let total=0;const chunks:Uint8Array[]=[];
 try {while(true){const r=await reader.read();if(r.done)break;total+=r.value.length;if(total>3*1024*1024){await reader.cancel();throw new Error("Request body exceeds 3 MiB");}chunks.push(r.value);}}
 finally {reader.releaseLock();}
 const v:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8"));
 if(!v || typeof v!=="object" || Array.isArray(v))throw new Error("Expected object");return v as Record<string,unknown>;
}
export function builderString(value:unknown):string {if(typeof value!=="string"||!value.trim()||value.length>256)throw new Error("Invalid identifier");return value;}
export function builderRevision(value:unknown):number {if(typeof value!=="number"||!Number.isSafeInteger(value)||value<0)throw new Error("Expected nonnegative revision");return value;}
export function builderError(error:unknown) {return Response.json({error:error instanceof Error?error.message:String(error)},{status:400});}
