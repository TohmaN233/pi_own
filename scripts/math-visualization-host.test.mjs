import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MathVisualizationHost, parseMathVisualSpec } from '../packages/math-visualization-host/src/index.ts';
const labels={title:'Linear map',purpose:'Predict then compare the area.',xLabel:'x',yLabel:'y'};
test('shared math: deterministic correct 2D and 3D data with scope isolation',()=>{
 const db=new DatabaseSync(':memory:');const host=new MathVisualizationHost(db);
 const a=host.create('study:one',{...labels,kind:'matrix2d',matrix:[[2,0],[0,3]]});
 assert.deepEqual(a.data[1].x,[0,2,2,0,0]);assert.deepEqual(a.data[1].y,[0,0,3,3,0]);
 assert.equal(host.create('study:one',a.spec).id,a.id);
 assert.throws(()=>host.get('course:one',a.id),/scope/);
 const b=host.create('course:one',{...labels,kind:'surface3d',zLabel:'z',shape:'saddle',scale:1,domain:[-1,1],samples:5});
 assert.equal(b.data[0].z[2][2],0);assert.equal(b.data[0].z[2][4],1);assert.equal(b.data[0].z[4][2],-1);
 assert.equal(new MathVisualizationHost(db).get('course:one',b.id).dataHash,b.dataHash);db.close();
});
test('shared math: rejects arbitrary JS, HTML labels, nonfinite values and huge specs',()=>{
 const spec={...labels,kind:'polynomial',coefficients:[0,1],domain:[-2,2],samples:21};
 assert.throws(()=>parseMathVisualSpec({...spec,javascript:'fetch(secret)'}),/Unknown/);
 assert.throws(()=>parseMathVisualSpec({...spec,title:'<script>bad</script>'}),/HTML/);
 assert.throws(()=>parseMathVisualSpec({...spec,coefficients:[Infinity]}),/finite/);
 assert.throws(()=>parseMathVisualSpec({...spec,samples:1000000}),/samples/);
});
