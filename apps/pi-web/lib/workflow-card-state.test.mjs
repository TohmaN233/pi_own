import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowCardEntries,workflowFeedback,workflowExecutorLabel} from './workflow-card-state.ts';

test('one stable card per Run keeps latest progress and independent Runs',()=>{
 const status=(run,status)=>({role:'custom',customType:'pi-caw:status',display:true,content:status,details:{run_id:run,workflow_name:'Course',status}});
 const first=status('a','running'),last=status('a','succeeded'),other=status('b','running');
 const messages=[{role:'user',content:'Build'},first,{role:'assistant',content:[]},other,last];
 const cards=workflowCardEntries(messages);
 assert.equal(cards.size,2);assert.equal(cards.get('a').first,1);assert.equal(cards.get('a').message,last);
 assert.equal(cards.get('b').first,3);assert.equal(workflowFeedback(last).status,'succeeded');
 assert.equal(workflowFeedback({...first,details:{run_id:'a'}}),null);
 assert.match(workflowExecutorLabel({executor:'pi-isolated-main'}),/独立上下文/);
 assert.equal(workflowExecutorLabel({executor:'tool'}),'Host 工具');
});
