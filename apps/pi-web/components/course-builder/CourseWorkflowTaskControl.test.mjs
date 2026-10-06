import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('./CourseWorkflowTaskControl.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module:ts.ModuleKind.CommonJS, jsx:ts.JsxEmit.ReactJSX } }).outputText;
function harness({ready=true,legacyStatus='succeeded'}={}) {
  const hooks=[],requests=[],timers=new Set(),controlRef={current:null};let cursor=0,effects=[],nextTimer=0,prepared,runStatus='running',refreshes=0;
  const legacy={taskId:'old-task',workflowId:'course-slide-revision',kind:'deck',target:{lessonId:'old-lesson'},materialIds:[],attachmentIds:['old-selected-attachment'],task:'old request',workspace:'G:/old-workspace',createdAt:'2026-10-01T00:00:00Z',runId:'old-run',startState:'confirmed'};
  const products=[{id:'course-beamer-deck',title:'Beamer 课件',kind:'deck',ready:true},{id:'course-slide-revision',title:'修改现有 Beamer',kind:'deck',ready:true}];
  const depsEqual=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>value===b[index]);
  const jsx=(type,props)=>({type,props}),testModule={exports:{}};
  vm.runInNewContext(compiled,{module:testModule,exports:testModule.exports,AbortController,URLSearchParams,Date,
    setInterval:()=>{const id=++nextTimer;timers.add(id);return id;},clearInterval:id=>timers.delete(id),
    fetch:async(url,options)=>{
      const body=options.body?JSON.parse(options.body):null;requests.push({url,body});
      if(body?.action==='prepare')prepared={...legacy,...body,taskId:'new-task',workflowId:'course-production',runId:undefined,productAction:body.productAction};
      if(body?.action==='run')prepared={...prepared,runId:'new-run',startState:'confirmed'};
      if(body?.action==='cancel')runStatus='cancelled';
      const taskId=new URL(url,'http://localhost').searchParams.get('taskId');
      const task=taskId==='old-task'?legacy:prepared;
      const result=body?.action==='prepare'?prepared:taskId?{...task,teacherReviewPending:true,files:[],run:{runId:task.runId,status:taskId==='old-task'?legacyStatus:runStatus,nodes:[]}}:
        {workflow:{id:'course-production',ready,disabledReason:ready?null:'主流程未 Ready'},products,tasks:prepared?[prepared,legacy]:[legacy]};
      return {ok:true,json:async()=>structuredClone(result)};
    },require:id=>{
      if(id==='react')return {
        useState:initial=>{const i=cursor++;if(!(i in hooks))hooks[i]=initial;return [hooks[i],next=>{hooks[i]=typeof next==='function'?next(hooks[i]):next;}];},
        useRef:initial=>{const i=cursor++;if(!(i in hooks))hooks[i]={current:initial};return hooks[i];},
        useCallback:(fn,deps)=>{const i=cursor++;if(!depsEqual(hooks[i]?.deps,deps))hooks[i]={fn,deps};return hooks[i].fn;},
        useEffect:(fn,deps)=>{const i=cursor++;if(!depsEqual(hooks[i]?.deps,deps)){const previous=hooks[i];hooks[i]={deps};effects.push(()=>{previous?.cleanup?.();hooks[i].cleanup=fn();});}},
        useImperativeHandle:(ref,fn)=>{ref.current=fn();},
      };
      if(id==='react/jsx-runtime')return {jsx,jsxs:jsx};
      if(id.includes('WorkspaceFilePreview'))return {WorkspaceFilePreview:()=>null};
      if(id.includes('course-workflow-launch-state'))return {courseWorkflowStartLabel:task=>task.startState??'pending',courseWorkflowLaunchCanRetry:task=>task.startState==='refused'};
      if(id.endsWith('.css'))return {default:{}};
      throw new Error(`Unexpected Course control import ${id}`);
    }});
  const render=()=>{cursor=0;effects=[];const tree=testModule.exports.CourseWorkflowTaskControl({sessionId:'teacher-session',controlRef,additionalRequirements:'extra repair requirement',onRefresh:async()=>{refreshes++;}});for(const effect of effects)effect();return tree;};
  const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));return render();};
  return {render,flush,controlRef,requests,timers,get refreshes(){return refreshes;}};
}
function nodes(tree){if(!tree||typeof tree!=='object')return [];if(Array.isArray(tree))return tree.flatMap(nodes);return [tree,...nodes(tree.props?.children)];}

test('product launch checks the one master and preserves attachments while old product Runs remain selectable and cancellable',async()=>{
  const h=harness();h.render();let tree=await h.flush();tree=await h.flush();
  assert.ok(nodes(tree).some(node=>node.type==='option'&&node.props.value==='old-task'&&node.props.children.includes('修改现有 Beamer')));
  await h.controlRef.current.launch({productAction:'course-beamer-deck',lessonId:'selected-lesson',task:'update exact slides\nextra requirement',attachmentIds:['selected-chat-attachment']});
  tree=h.render();tree=await h.flush();
  const prepared=h.requests.find(item=>item.body?.action==='prepare').body;
  assert.equal(prepared.productAction,'course-beamer-deck');assert.equal(prepared.lessonId,'selected-lesson');assert.equal('workflowId' in prepared,false);
  assert.deepEqual(prepared.attachmentIds,['selected-chat-attachment']);assert.match(prepared.task,/extra requirement/);
  assert.equal('baselineTaskId' in prepared,false);
  assert.ok(h.requests.some(item=>item.body?.action==='run'&&item.body.taskId==='new-task'));
  assert.ok(h.requests.some(item=>item.url.includes('taskId=old-task')));assert.equal(h.timers.size,1);
  await nodes(tree).find(node=>node.type==='button'&&node.props.children==='取消此 Run').props.onClick();tree=await h.flush();
  assert.ok(h.requests.some(item=>item.body?.action==='cancel'&&item.body.taskId==='new-task'));assert.ok(h.refreshes>0);
});

test('history repair references only the explicitly selected failed task and preserves its exact target and sources',async()=>{
  const h=harness({legacyStatus:'failed'});h.render();await h.flush();let tree=await h.flush();
  assert.equal(h.requests.some(item=>item.body?.action==='prepare'),false);
  nodes(tree).find(node=>node.type==='button'&&node.props.children==='修复此任务已保存的产物').props.onClick();await h.flush();
  const prepared=h.requests.find(item=>item.body?.action==='prepare').body;
  assert.equal(prepared.baselineTaskId,'old-task');assert.equal(prepared.productAction,'course-slide-revision');assert.equal(prepared.lessonId,'old-lesson');
  assert.deepEqual(prepared.attachmentIds,['old-selected-attachment']);assert.match(prepared.task,/extra repair requirement/);
});

test('unavailable master reports its diagnostic without falling back to a legacy per-product Workflow',async()=>{
  const h=harness({ready:false});h.render();await h.flush();
  await assert.rejects(h.controlRef.current.launch({productAction:'course-beamer-deck',lessonId:'lesson',task:'make slides'}),/主流程未 Ready/);
  assert.equal(h.requests.some(item=>item.body?.action==='prepare'||item.body?.action==='run'),false);
});
