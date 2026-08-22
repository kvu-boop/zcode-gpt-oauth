'use strict';
const test=require('node:test'); const assert=require('node:assert/strict'); const {resolvePricing}=require('../server/cache/pricing'); const {calculateAdditionalCacheMissCost}=require('../server/cache/cost');
test('resolves explicit OpenAI context price',()=>{const p=resolvePricing({provider:'openai',model:'gpt-5.6-sol',tier:'standard',contextBand:'short'}); assert.equal(p.status,'resolved'); assert.equal(p.record.inputPerMillion,4);});
test('GPT OAuth has no USD pricing',()=>assert.equal(resolvePricing({provider:'chatgpt-oauth',model:'gpt-5.6-sol'}).status,'not_found'));
test('incremental cost clamps and calculates',()=>{const p=resolvePricing({provider:'openai',model:'gpt-5.6-sol',tier:'standard',contextBand:'short'}); const c=calculateAdditionalCacheMissCost({missedTokens:{value:20000,confidence:'derived'},priceResolution:p}); assert.equal(c.value,.072); assert.equal(c.formula,'inputMinusRead');});
