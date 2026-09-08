import { extname } from "node:path";
import { extractPptx, type CourseBuilderMaterialInput } from "../../../packages/course-builder-host/src/index.ts";
import { PdftotextExtractor } from "../../../packages/course-host/src/index.ts";

export function courseBuilderKindForName(name: string): CourseBuilderMaterialInput["kind"] {
 const ext=extname(name).toLowerCase();
 if(ext===".pptx")return "pptx";
 if(ext===".pdf")return "pdf";
 if(ext===".tex")return "tex";
 if(ext===".md"||ext===".mdx")return "markdown";
 if(ext===".txt")return "text";
 return "asset";
}

function decodeTextIfSafe(bytes: Uint8Array): string | null {
 try {
  const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  let controls=0;
  for(const character of text) {
   const code=character.charCodeAt(0);
   if(code<32 && code!==9 && code!==10 && code!==13)controls+=1;
  }
  return controls>Math.max(2,Math.floor(text.length*0.005)) ? null : text;
 } catch { return null; }
}

export async function extractCourseBuilderMaterial(bytes: Uint8Array,name: string): Promise<Pick<CourseBuilderMaterialInput,"kind"|"extractedText"|"metadata">> {
 const ext=extname(name).toLowerCase();
 if(ext===".pptx") {const pptx=extractPptx(bytes);return {kind:"pptx",extractedText:pptx.text,metadata:{...pptx.metadata,extraction:"pptx"}};}
 if(ext===".pdf") return {kind:"pdf",extractedText:await new PdftotextExtractor({command:process.env.PI_PDFTOTEXT_PATH || "pdftotext",maxOutputBytes:8*1024*1024}).extract(bytes,name),metadata:{extraction:"pdftotext"}};
 if([".tex",".md",".mdx",".txt"].includes(ext)) {
  const extractedText=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  return {kind:courseBuilderKindForName(name),extractedText,metadata:{extraction:"utf-8"}};
 }
 if([".png",".jpg",".jpeg"].includes(ext)) {
  const b=Buffer.from(bytes);
  const valid=ext===".png" ? b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : b[0]===255 && b[1]===216;
  return {kind:"asset",extractedText:`Image asset ${name}; image semantics have not been extracted.`,metadata:{extraction:"image-asset",signatureValid:valid}};
 }
 const text=decodeTextIfSafe(bytes);
 if(text!==null)return {kind:"text",extractedText:text,metadata:{extraction:"utf-8-sniffed",declaredExtension:ext}};
 return {kind:"asset",extractedText:`Binary material ${name} is available as a source, but no text adapter is installed for ${ext||"this file type"}.`,metadata:{extraction:"unavailable",declaredExtension:ext}};
}

export async function parseCourseBuilderFiles(files: File[]): Promise<CourseBuilderMaterialInput[]> {
 if (!files.length || files.length>100 || files.reduce((n,f)=>n+f.size,0)>64*1024*1024) throw new Error("Upload requires 1..100 files within 64 MiB");
 const out:CourseBuilderMaterialInput[]=[]; let textBytes=0;
 for(const file of files) {
  if (!file.name || file.name.length>256 || /[\\/\x00-\x1f]/u.test(file.name)) throw new Error("Unsafe material filename");
  const bytes=new Uint8Array(await file.arrayBuffer());
  const {kind,extractedText,metadata}=await extractCourseBuilderMaterial(bytes,file.name);
  textBytes+=Buffer.byteLength(extractedText,"utf8"); if (textBytes>16*1024*1024) throw new Error("Extracted text exceeds import budget");
  out.push({name:file.name,kind,sourceBytes:bytes,extractedText,metadata});
 }
 return out;
}
