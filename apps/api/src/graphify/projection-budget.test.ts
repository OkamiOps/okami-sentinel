import assert from 'node:assert/strict';
import test from 'node:test';
import { projectionBudget } from './projection-budget.js';
test('projection allocation accounts for complete prompt, provider context and completion reserve', () => {
 const empty=projectionBudget('',300000,32768);
 assert.ok(empty>0);
 assert.ok(projectionBudget('source'.repeat(10000),300000,32768)<empty);
 assert.ok(projectionBudget('',128000,32768)<empty);
 assert.ok(projectionBudget('',300000,65536)<empty);
 assert.equal(projectionBudget('x'.repeat(600000),300000,32768),0);
 assert.equal(projectionBudget('',1000000,32768),empty);
});
