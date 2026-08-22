'use strict';
const NOISE_FLOOR=1024, NOTICE_TOKEN_THRESHOLD=20000, NOTICE_COST_THRESHOLD_USD=.10;
function valid(u){return u&&u.inputTokens&&Number.isSafeInteger(u.inputTokens.value)&&u.inputTokens.value>0;}
function key(u){return [u&&u.provider,u&&u.sessionId,u&&u.lineageId].join('\0');}
function detectCacheMiss(previous,current,policy={},pricingContext){
 if(policy.cacheMissNotices===false||policy.enabled===false||!valid(current)||!current.sessionId||!current.lineageId||!previous||!valid(previous))return null;
 if(current.cacheTelemetry!=='supported'||previous.cacheTelemetry!=='supported')return null;
 if(current.capabilityId&&previous.capabilityId&&current.capabilityId!==previous.capabilityId)return null;
 if(previous.provider!==current.provider)return null;
 const overlap=Math.min(previous.inputTokens.value,current.inputTokens.value);let missed;
 if(current.cacheMissTokens&&current.cacheMissTokens.confidence==='reported'&&current.cacheReadTokens)missed=Math.min(overlap,current.cacheMissTokens.value);
 else if(current.cacheReadTokens)missed=Math.max(0,overlap-current.cacheReadTokens.value);else return null;
 if(missed<=(policy.noiseFloorTokens||NOISE_FLOOR))return null;
 const cost=pricingContext&&pricingContext.cost||null;
 return{missedTokens:{value:missed,confidence:'derived'},idleMs:Math.max(0,(current.observedAtMs||0)-(previous.observedAtMs||0)),modelChanged:previous.model!==current.model,cost,significant:missed>=(policy.noticeTokenThreshold||NOTICE_TOKEN_THRESHOLD)||!!(cost&&cost.currency==='USD'&&cost.value>=(policy.noticeCostThresholdUsd||NOTICE_COST_THRESHOLD_USD)),previous,current};
}
 class CacheUsageTracker{
 constructor({maxEntries=1000,ttlMs=48*60*60*1000}={}){this.maxEntries=maxEntries;this.ttlMs=ttlMs;this.records=new Map;this.clock=0;}
 _purge(now){for(const[id,r]of this.records){const activity=r.inFlight?r.inFlight.begunAtMs:r.lastActivityMs;if(now-activity>this.ttlMs)this.records.delete(id);}}
 _bound(){while(this.records.size>this.maxEntries){let oldestId,oldestAt=Infinity,oldestGeneration=Infinity;for(const[id,r]of this.records){const at=r.inFlight?r.inFlight.begunAtMs:r.lastActivityMs;const generation=r.inFlight?r.inFlight.generation:0;if(at<oldestAt||(at===oldestAt&&generation<oldestGeneration)){oldestId=id;oldestAt=at;oldestGeneration=generation;}}if(oldestId===undefined)break;this.records.delete(oldestId);}}
 begin(usage,options={}){const id=key(usage),now=Date.now();this._purge(now);const r=this.records.get(id)||{snapshot:null,lastActivityMs:now,inFlight:null};const generation=++this.clock;r.lastActivityMs=now;r.inFlight={generation,begunAtMs:now,reset:!!options.reset};if(options.reset)r.snapshot=null;this.records.delete(id);this.records.set(id,r);this._bound();return{id,generation,begunAtMs:now,options};}
 preview(token,usage,options={}){if(!token||!usage||!this._isLatest(token))return null;const r=this.records.get(token.id);if(options.reset||token.options&&token.options.reset)return null;return detectCacheMiss(r&&r.snapshot,usage,options.policy||options,options.pricingContext);}
 commit(token,usage=token&&token.usage,options=token&&token.options){if(!token||!usage||!this._isLatest(token))return null;const r=this.records.get(token.id);r.inFlight=null;r.lastActivityMs=Date.now();if(valid(usage)&&usage.sessionId&&usage.lineageId){r.snapshot=usage;this.records.delete(token.id);this.records.set(token.id,r);this._bound();}return null;}
 cancel(token){if(!token||!this._isLatest(token))return false;const r=this.records.get(token.id);r.inFlight=null;if(token.options&&token.options.reset)r.snapshot=null;if(r.snapshot){r.lastActivityMs=Date.now();}else this.records.delete(token.id);return true;}
 complete(token,usage=token&&token.usage,options=token&&token.options){const d=this.preview(token,usage,options||{});this.commit(token,usage,options||{});return d;}
 observe(usage,options={}){const t=this.begin(usage,options);return this.complete(t,usage,options);}
 _isLatest(t){const r=this.records.get(t.id);return !!(r&&r.inFlight&&r.inFlight.generation===t.generation);}
 clear(){this.records.clear();}
 }
function createTracker(options){return new CacheUsageTracker(options);}
module.exports={CacheUsageTracker,createTracker,detectCacheMiss,key,NOISE_FLOOR,NOTICE_TOKEN_THRESHOLD,NOTICE_COST_THRESHOLD_USD};
