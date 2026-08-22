'use strict';
function isSignificant(d,cost) { return !!d && (d.missedTokens.value>=20000 || !!(cost&&cost.currency==='USD'&&cost.value>=0.10)); }
function buildCacheNotice(detection,priceResolution) { if(!detection)return null; const cost=detection.cost||null; if(!isSignificant(detection,cost))return null; const c=detection.current||{}; return{type:'cache_miss',provider:c.provider,model:c.model,sessionId:c.sessionId,observedAtMs:c.observedAtMs,idleMs:detection.idleMs,modelChanged:!!detection.modelChanged,rebilledTokens:detection.missedTokens,additionalCost:cost,significant:true}; }
function formatCacheNotice(n){if(!n)return'';return`Cache miss: ${n.rebilledTokens.value.toLocaleString('en-US')} tokens re-billed`;}
module.exports={buildCacheNotice,formatCacheNotice,isSignificant};
