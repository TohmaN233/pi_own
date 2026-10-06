import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('./ModeSettingsPanel.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const initial = () => ({ modePackId:'course-builder', snapshotId:'pin-original', systemPrompt:'original prompt', tools:[], skills:[],
  workflows:[{id:'course-lesson-plan',name:'Lesson plan',enabled:true,defaultEnabled:true,globalEnabled:false,effectiveEnabled:false}],
  workflowScope:{modePackId:'course-builder',snapshotId:'pin-original',origin:'package-origin',revision:0,executionAvailable:true,pluginEnabled:true,reason:null},
  verified:true,live:true,busy:false });

function harness() {
  const hooks=[],effects=[],requests=[];let cursor=0,mounted=false,configurationChanged,settings=initial(),conflict=false,activationCount=0;
  const jsx=(type,props)=>({type,props});
  const sandboxModule={exports:{}};
  const context={module:sandboxModule,exports:sandboxModule.exports,AbortController,crypto:{randomUUID:()=> 'offline-request'},
    fetch:async (_url,options={})=>{
      if(options.method==='POST') {
        const body=JSON.parse(options.body);requests.push(body);
        if(conflict)return {ok:false,json:async()=>({error:'Workflow settings revision conflict; reload before saving'})};
        for(const item of body.settingsPatch.workflows)settings.workflows.find(row=>row.id===item.id).enabled=item.enabled;
        settings.workflowScope.revision++;
      }
      return {ok:true,json:async()=>structuredClone(settings)};
    },require:id=>{
      if(id==='react')return {
        useState:value=>{const i=cursor++;if(!(i in hooks))hooks[i]=value;return [hooks[i],next=>{hooks[i]=typeof next==='function'?next(hooks[i]):next;}];},
        useRef:value=>{const i=cursor++;if(!(i in hooks))hooks[i]={current:value};return hooks[i];},
        useCallback:fn=>fn,useEffect:fn=>{if(!mounted)effects.push(fn);},
      };
      if(id==='react/jsx-runtime')return {jsx,jsxs:jsx};
      if(id.includes('mode-pack-client'))return {activateModePack:async()=>{activationCount++;}};
      if(id.includes('session-configuration-events'))return {notifySessionConfiguration:()=>{},subscribeSessionConfiguration:(_sid,callback)=>{configurationChanged=callback;return ()=>{};}};
      if(id.endsWith('.css'))return {default:{}};
      throw new Error(`Unexpected panel import: ${id}`);
    }};
  vm.runInNewContext(compiled,context);
  const render=()=>{cursor=0;const tree=sandboxModule.exports.ModeSettingsPanel({sessionId:'exact-session',section:'all'});if(!mounted){mounted=true;for(const effect of effects)effect();}return tree;};
  const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));return render();};
  return {render,flush,requests,setConflict:()=>{conflict=true;},externalChange:()=>{settings.workflowScope.revision++;configurationChanged();},get activationCount(){return activationCount;}};
}
function nodes(tree) {
  if(!tree||typeof tree!=='object')return [];
  if(Array.isArray(tree))return tree.flatMap(nodes);
  return [tree,...nodes(tree.props?.children)];
}
function button(tree,label){return nodes(tree).find(node=>node.type==='button'&&node.props.children===label);}
function workflowCheckbox(tree){return nodes(tree).find(node=>node.type==='input'&&node.props.type==='checkbox'&&node.props.checked===true);}

test('Workflow save sends only preference CAS and preserves unrelated unsaved prompt through its async refresh',async()=>{
  const h=harness();h.render();let tree=await h.flush();
  assert.ok(nodes(tree).some(node=>node.props?.children==='共享定义已全局停用；此模式的选择已保存，暂不能启动。'));
  nodes(tree).find(node=>node.type==='textarea').props.onChange({target:{value:'unsaved custom prompt'}});
  workflowCheckbox(tree).props.onChange({target:{checked:false}});tree=h.render();
  await button(tree,'保存 Workflow 组合').props.onClick();tree=await h.flush();
  assert.equal(h.requests.length,1);assert.equal(h.activationCount,0);
  const request=h.requests[0];assert.equal(request.sessionId,'exact-session');assert.equal(request.expectedSnapshotId,'pin-original');assert.equal(request.expectedWorkflowRevision,0);
  assert.deepEqual(request.settingsPatch,{workflows:[{id:'course-lesson-plan',enabled:false}]});
  assert.equal(nodes(tree).find(node=>node.type==='textarea').props.value,'unsaved custom prompt');
  assert.equal(button(tree,'保存 Workflow 组合').props.disabled,true);
});

test('concurrent Workbench preference update keeps the editing revision and reports an explicit save conflict',async()=>{
  const h=harness();h.render();let tree=await h.flush();
  workflowCheckbox(tree).props.onChange({target:{checked:false}});h.externalChange();tree=await h.flush();h.setConflict();
  await button(tree,'保存 Workflow 组合').props.onClick();tree=await h.flush();
  assert.equal(h.requests[0].expectedWorkflowRevision,0);assert.equal(h.activationCount,0);
  assert.ok(nodes(tree).some(node=>node.props?.role==='alert'&&nodes(node).some(child=>Array.isArray(child.props?.children)&&child.props.children.includes('Workflow settings revision conflict; reload before saving'))));
  assert.equal(button(tree,'保存 Workflow 组合').props.disabled,false);
});
