'use strict';
const CONFIDENCE = new Set(['reported', 'derived', 'estimated']);
const SUPPORT = new Set(['supported', 'unsupported', 'unknown']);
function metric(value, confidence, source) {
  if (!Number.isSafeInteger(value) || value < 0 || !CONFIDENCE.has(confidence)) return null;
  return { value, confidence, source: String(source || 'unknown') };
}
function ratioMetric(value, confidence, source) {
  if (!Number.isFinite(value) || value < 0 || value > 1 || !CONFIDENCE.has(confidence)) return null;
  return { value, confidence, source: String(source || 'unknown') };
}
function validateMetric(m) { return m && Number.isSafeInteger(m.value) ? metric(m.value, m.confidence, m.source) : null; }
function normalizeBase(x = {}) {
  return { provider:String(x.provider || ''), model:String(x.model || ''), pricingTier:x.pricingTier == null ? null : String(x.pricingTier), sessionId:x.sessionId == null ? null : String(x.sessionId), lineageId:x.lineageId == null ? null : String(x.lineageId), observedAtMs:Number.isFinite(x.observedAtMs) ? x.observedAtMs : Date.now(), cacheTelemetry:SUPPORT.has(x.cacheTelemetry) ? x.cacheTelemetry : 'unknown', telemetrySchema:x.telemetrySchema == null ? null : String(x.telemetrySchema), capabilityId:x.capabilityId == null ? null : String(x.capabilityId), inputTokens:validateMetric(x.inputTokens), outputTokens:validateMetric(x.outputTokens), cacheReadTokens:validateMetric(x.cacheReadTokens), cacheWriteTokens:validateMetric(x.cacheWriteTokens), cacheMissTokens:validateMetric(x.cacheMissTokens), uncachedInputTokens:validateMetric(x.uncachedInputTokens), cacheHitRate:ratioMetric(x.cacheHitRate && x.cacheHitRate.value, x.cacheHitRate && x.cacheHitRate.confidence, x.cacheHitRate && x.cacheHitRate.source), diagnostics:Array.isArray(x.diagnostics) ? x.diagnostics.slice() : [] };
}
module.exports = { metric, numberMetric:metric, ratioMetric, validateMetric, normalizeBase, CONFIDENCE, SUPPORT };
