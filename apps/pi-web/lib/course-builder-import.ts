import { extname } from "node:path";
import { extractPptx, type CourseBuilderMaterialInput } from "../../../packages/course-builder-host/src/index.ts";
import { PdftotextExtractor } from "../../../packages/course-host/src/index.ts";

export async function parseCourseBuilderFiles(files: File[]): Promise<CourseBuilderMaterialInput[]> {
 if (!files.length || files.length>100 || files.reduce((n,f)=>n+f.size,0)>64*1024*1024) throw new Error("Upload requires 1..100 files within 64 MiB");
 const out:CourseBuilderMaterialInput[]=[]; let textBytes=0;
 for(const file of files) {
  if (!file.name || file.name.length>256 || /[\\/\x00-\x1f]/u.test(file.name)) throw new Error("Unsafe material filename");
  const bytes=new Uint8Array(await file.arrayBuffer()), ext=extname(file.name).toLowerCase();
  let kind:CourseBuilderMaterialInput["kind"], extractedText:string, metadata:CourseBuilderMaterialInput["metadata"]={};
  if(ext===".pptx") {const pptx=extractPptx(bytes);kind="pptx";extractedText=pptx.text;metadata=pptx.metadata;}
  else if(ext===".pdf") {kind="pdf";extractedText=await new PdftotextExtractor({command:process.env.PI_PDFTOTEXT_PATH || "pdftotext",maxOutputBytes:8*1024*1024}).extract(bytes,file.name);}
  else if([".tex",".md",".txt"].includes(ext)) {kind=ext===".tex"?"tex":ext===".md"?"markdown":"text";extractedText=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}
  else if([".png",".jpg",".jpeg"].includes(ext)) {
   const b=Buffer.from(bytes);
   if (!(ext===".png" ? b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : b[0]===255 && b[1]===216)) throw new Error("Invalid image asset");
   kind="asset";extractedText=`Image asset ${file.name}; image semantics have not been extracted.`;
  } else throw new Error(`Unsupported file type ${ext}`);
  textBytes+=Buffer.byteLength(extractedText,"utf8"); if (textBytes>16*1024*1024) throw new Error("Extracted text exceeds import budget");
  out.push({name:file.name,kind,sourceBytes:bytes,extractedText,metadata});
 }
 return out;
}
