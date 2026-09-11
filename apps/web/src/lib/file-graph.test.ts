import assert from 'node:assert/strict';
import test from 'node:test';
import { createFileGraph, graphNeighbors } from './file-graph';
test('force layout retains isolated files, directions and input data without mutating API artifacts',()=>{
 const data={status:'ready' as const,snapshot:null,files:[{path:'a.ts'},{path:'b.ts'},{path:'isolated.ts'}],edges:[{source:'a.ts',target:'b.ts',count:3}]};const before=JSON.stringify(data);
 const graph=createFileGraph(data);graph.simulation.tick(30);graph.simulation.stop();
 assert.equal(graph.nodes.length,3);assert.equal(graph.links[0].source.id,'a.ts');assert.equal(graph.links[0].target.id,'b.ts');assert.equal(graph.links[0].count,3);
 assert.deepEqual([...graphNeighbors(graph.links,'a.ts')],['a.ts','b.ts']);assert.deepEqual([...graphNeighbors(graph.links,'isolated.ts')],['isolated.ts']);
 assert.ok(graph.nodes.every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y)));assert.equal(JSON.stringify(data),before);
});
