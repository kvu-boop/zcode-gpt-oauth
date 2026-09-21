'use strict';

/**
 * Idempotent, backup-first registration of the local gpt-oauth proxy in the
 * ZCode provider registries.
 *
 * Two files are maintained:
 *   - <home>/.zcode/v2/provider_config.json  (canonical schema v1 registry that
 *     ZCode 3.14.1+ reads for the model picker)
 *   - <home>/.zcode/v2/config.json           (legacy registry kept for older
 *     releases)
 *
 * The module is dependency free, exports pure-ish helpers for unit tests and
 * only runs its CLI when `require.main === module`.
 *
 * Nothing in the returned summary or in the CLI output contains values read
 * from other providers (no apiKey / token / secret is ever echoed).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;

const PROVIDER_NAME = 'gpt-oauth';
const PROVIDER_KIND = 'openai-compatible';
const PROVIDER_SOURCE = 'custom';
const PROVIDER_GROUP = 'standard-personal';
// Public placeholder value; the local proxy does not validate it.
const API_KEY_LITERAL = 'local-proxy';
const API_TYPE = 'openai-chat-completions';
const BASE_URL = 'http://127.0.0.1:8787/v1';

const GPT_MODEL_IDS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra'];
const GROK_MODEL_IDS = [
  'grok-4.6',
  'grok-4.5',
  'grok-4.3',
  'grok-build-0.1',
  'grok-4.20-0309-reasoning',
  'grok-4.20-0309-non-reasoning',
];
const ALL_MODEL_IDS = [...GPT_MODEL_IDS, ...GROK_MODEL_IDS];

class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
    this.code = 'SETUP_ERROR';
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function inputFormat(options = {}) {
  return {
    supportsText: true,
    supportsImage: true,
    supportsVideo: options.video === true,
    supportsAudio: options.audio === true,
    supportsPdf: options.pdf === true,
  };
}

const TEXT_IMAGE_INPUT = inputFormat();
const TEXT_IMAGE_PDF_INPUT = inputFormat({ pdf: true });

function providerModelRule(options) {
  const rule = { properties: { contextWindow: options.contextWindow } };
  if (options.inputFormat) rule.properties.inputFormat = options.inputFormat;
  const optionSpecs = {};
  if (options.reasoningLevelValues) optionSpecs.reasoningLevel = { values: options.reasoningLevelValues };
  if (options.maxOutputTokens !== undefined) optionSpecs.maxOutputTokens = { max: options.maxOutputTokens };
  if (Object.keys(optionSpecs).length > 0) rule.optionSpecs = optionSpecs;
  return rule;
}

// Canonical `modelConfigRules.providerModelRules[].config` per model.
const PROVIDER_MODEL_RULES = {
  'gpt-5.6-sol': providerModelRule({ contextWindow: 256000 }),
  'gpt-5.6-terra': providerModelRule({ contextWindow: 256000 }),
  'gpt-5.6-luna': providerModelRule({ contextWindow: 256000 }),
  'gpt-6-astra': providerModelRule({ contextWindow: 256000 }),
  'grok-4.6': providerModelRule({
    contextWindow: 500000,
    inputFormat: TEXT_IMAGE_INPUT,
    reasoningLevelValues: ['low', 'medium', 'high', 'xhigh'],
    maxOutputTokens: 128000,
  }),
  'grok-4.5': providerModelRule({
    contextWindow: 500000,
    inputFormat: TEXT_IMAGE_INPUT,
    reasoningLevelValues: ['low', 'medium', 'high'],
    maxOutputTokens: 128000,
  }),
  'grok-4.3': providerModelRule({ contextWindow: 1000000, inputFormat: TEXT_IMAGE_INPUT, maxOutputTokens: 128000 }),
  'grok-build-0.1': providerModelRule({ contextWindow: 256000, inputFormat: TEXT_IMAGE_INPUT, maxOutputTokens: 128000 }),
  'grok-4.20-0309-reasoning': providerModelRule({
    contextWindow: 1000000,
    inputFormat: TEXT_IMAGE_INPUT,
    maxOutputTokens: 30000,
  }),
  'grok-4.20-0309-non-reasoning': providerModelRule({
    contextWindow: 1000000,
    inputFormat: TEXT_IMAGE_INPUT,
    maxOutputTokens: 30000,
  }),
};

function legacyModel(options) {
  const spec = {};
  if (options.reasoning) spec.reasoning = options.reasoning;
  spec.limit = { context: options.context, output: options.output };
  spec.modalities = { input: options.input || ['text', 'image'], output: ['text'] };
  return spec;
}

// Canonical legacy `provider.<id>.models` entries.
const LEGACY_MODEL_SPECS = {
  'gpt-5.6-sol': legacyModel({ context: 256000, output: 128000 }),
  'gpt-5.6-terra': legacyModel({ context: 256000, output: 128000 }),
  'gpt-5.6-luna': legacyModel({ context: 256000, output: 128000 }),
  'gpt-6-astra': legacyModel({
    context: 256000,
    output: 128000,
    reasoning: { enabled: true, variants: ['low', 'medium', 'high', 'xhigh', 'max'], defaultVariant: 'high' },
  }),
  'grok-4.6': legacyModel({
    context: 500000,
    output: 500000,
    input: ['text', 'image', 'pdf'],
    reasoning: { enabled: true, variants: ['low', 'medium', 'high', 'xhigh'], defaultVariant: 'high' },
  }),
  'grok-4.5': legacyModel({
    context: 500000,
    output: 500000,
    input: ['text', 'image', 'pdf'],
    reasoning: { enabled: true, variants: ['low', 'medium', 'high'] },
  }),
  'grok-4.3': legacyModel({
    context: 1000000,
    output: 30000,
    input: ['text', 'image', 'pdf'],
    reasoning: { enabled: true, variants: ['none', 'low', 'medium', 'high'] },
  }),
  'grok-build-0.1': legacyModel({ context: 256000, output: 256000, input: ['text', 'image', 'pdf'] }),
  'grok-4.20-0309-reasoning': legacyModel({
    context: 1000000,
    output: 30000,
    input: ['text', 'image', 'pdf'],
    reasoning: { enabled: true },
  }),
  'grok-4.20-0309-non-reasoning': legacyModel({
    context: 1000000,
    output: 30000,
    input: ['text', 'image', 'pdf'],
  }),
};

function zcodeV2Dir(home) {
  return path.join(home, '.zcode', 'v2');
}

function providerStateDir(home) {
  return path.join(home, '.zcode', PROVIDER_NAME);
}

function providerConfigPathFor(home) {
  return path.join(zcodeV2Dir(home), 'provider_config.json');
}

function legacyConfigPathFor(home) {
  return path.join(zcodeV2Dir(home), 'config.json');
}

function providerUuidPathFor(home) {
  return path.join(providerStateDir(home), 'provider-uuid');
}

function localTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function resolveProviderId(home) {
  try {
    const raw = fs.readFileSync(providerUuidPathFor(home), 'utf8').trim();
    if (raw) return raw;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  return crypto.randomUUID();
}

function emptyProviderConfig() {
  return {
    schemaVersion: SCHEMA_VERSION,
    config: {
      providerOrder: [],
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
}

/**
 * Reads and parses a JSON file. Returns `{ exists: false }` when absent and
 * throws a SetupError (without echoing file content) when the JSON is broken.
 */
function readJsonFileIfExists(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, value: undefined };
    throw err;
  }
  try {
    return { exists: true, value: JSON.parse(raw) };
  } catch (err) {
    throw new SetupError(`invalid JSON in ${filePath}; refusing to modify it`);
  }
}

function assertSchemaVersion(value, filePath) {
  if (!isPlainObject(value)) {
    throw new SetupError(`${filePath}: expected a JSON object at the top level`);
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new SetupError(
      `${filePath}: unsupported schemaVersion ${JSON.stringify(value.schemaVersion)} ` +
        `(expected ${SCHEMA_VERSION}); refusing to modify it`,
    );
  }
}

function ensureArray(container, key, filePath) {
  const current = container[key];
  if (current === undefined || current === null) {
    container[key] = [];
    return container[key];
  }
  if (!Array.isArray(current)) {
    throw new SetupError(`${filePath}: expected "${key}" to be an array`);
  }
  return current;
}

function ensureObject(container, key, filePath) {
  const current = container[key];
  if (current === undefined || current === null) {
    container[key] = {};
    return container[key];
  }
  if (!isPlainObject(current)) {
    throw new SetupError(`${filePath}: expected "${key}" to be an object`);
  }
  return current;
}

function fillMissing(target, key, value) {
  if (target[key] === undefined || target[key] === null) target[key] = value;
}

function appendMissingIds(list, ids) {
  const added = [];
  for (const id of ids) {
    if (!list.includes(id)) {
      list.push(id);
      added.push(id);
    }
  }
  return added;
}

/**
 * Merges the canonical rule into a schema v1 provider config object (mutates
 * `draft`). Existing providers, rules, ordering and unknown fields survive.
 */
function mergeProviderConfig(draft, fallbackProviderId, options = {}) {
  const filePath = options.filePath || 'provider_config.json';
  if (!isPlainObject(draft)) throw new SetupError(`${filePath}: expected a JSON object at the top level`);
  const config = ensureObject(draft, 'config', filePath);

  const providerOrder = ensureArray(config, 'providerOrder', filePath);
  const providerConfigRules = ensureObject(config, 'providerConfigRules', filePath);
  const providerRules = ensureArray(providerConfigRules, 'providerRules', filePath);
  const modelConfigRules = ensureObject(config, 'modelConfigRules', filePath);
  const providerModelRules = ensureArray(modelConfigRules, 'providerModelRules', filePath);
  ensureArray(modelConfigRules, 'manualProviderModelRules', filePath);

  let rule = providerRules.find((entry) => isPlainObject(entry) && entry.providerName === PROVIDER_NAME);
  let created = false;
  if (!rule) {
    rule = providerRules.find((entry) => isPlainObject(entry) && entry.providerId === fallbackProviderId);
  }
  if (!rule) {
    rule = { providerId: fallbackProviderId, providerName: PROVIDER_NAME, config: {} };
    providerRules.push(rule);
    created = true;
  }

  if (rule.providerName === undefined || rule.providerName === null) rule.providerName = PROVIDER_NAME;
  const providerId =
    typeof rule.providerId === 'string' && rule.providerId.length > 0 ? rule.providerId : fallbackProviderId;
  if (rule.providerId !== providerId) rule.providerId = providerId;

  // Keep existing group/access/api values; only fill in what is missing.
  const ruleConfig = ensureObject(rule, 'config', filePath);
  fillMissing(ruleConfig, 'group', PROVIDER_GROUP);

  const access = ensureObject(ruleConfig, 'access', filePath);
  fillMissing(access, 'type', 'api-key');
  fillMissing(access, 'apiKey', API_KEY_LITERAL);

  const api = ensureObject(ruleConfig, 'api', filePath);
  fillMissing(api, 'type', API_TYPE);
  fillMissing(api, 'baseUrl', BASE_URL);

  const addedModelIds = [];
  for (const key of ['personalModelIds', 'modelOrder']) {
    const list = ensureArray(ruleConfig, key, filePath);
    for (const id of appendMissingIds(list, ALL_MODEL_IDS)) {
      if (!addedModelIds.includes(id)) addedModelIds.push(id);
    }
  }

  const addedModelRuleIds = [];
  for (const modelId of ALL_MODEL_IDS) {
    const exists = providerModelRules.some(
      (entry) => isPlainObject(entry) && entry.providerId === providerId && entry.modelId === modelId,
    );
    if (exists) continue;
    providerModelRules.push({
      providerId,
      modelId,
      config: cloneJson(PROVIDER_MODEL_RULES[modelId]),
    });
    addedModelRuleIds.push(modelId);
  }

  const addedToOrder = !providerOrder.includes(providerId);
  if (addedToOrder) providerOrder.push(providerId);

  return { draft, providerId, ruleCreated: created, addedModelIds, addedModelRuleIds, addedToOrder };
}

/**
 * Merges the canonical legacy provider entry into a legacy config object
 * (mutates `draft`). All unrelated providers/keys are preserved.
 */
function mergeLegacyConfig(draft, providerId, options = {}) {
  const filePath = options.filePath || 'config.json';
  if (!isPlainObject(draft)) throw new SetupError(`${filePath}: expected a JSON object at the top level`);
  const providers = ensureObject(draft, 'provider', filePath);

  let providerKey = null;
  for (const [key, value] of Object.entries(providers)) {
    if (isPlainObject(value) && value.name === PROVIDER_NAME) {
      providerKey = key;
      break;
    }
  }
  if (providerKey === null) providerKey = providerId;

  let entry = providers[providerKey];
  let created = false;
  if (!isPlainObject(entry)) {
    entry = {};
    providers[providerKey] = entry;
    created = true;
  }

  fillMissing(entry, 'name', PROVIDER_NAME);
  fillMissing(entry, 'kind', PROVIDER_KIND);
  fillMissing(entry, 'source', PROVIDER_SOURCE);

  const entryOptions = ensureObject(entry, 'options', filePath);
  fillMissing(entryOptions, 'apiKey', API_KEY_LITERAL);
  fillMissing(entryOptions, 'baseURL', BASE_URL);
  fillMissing(entryOptions, 'apiKeyRequired', true);

  const models = ensureObject(entry, 'models', filePath);
  const addedModelIds = [];
  for (const modelId of ALL_MODEL_IDS) {
    if (models[modelId] === undefined || models[modelId] === null) {
      models[modelId] = cloneJson(LEGACY_MODEL_SPECS[modelId]);
      addedModelIds.push(modelId);
    }
  }

  return { draft, providerKey, entryCreated: created, addedModelIds };
}

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  let mode = 0o600;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    fs.writeFileSync(tmpPath, content, { mode });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch (cleanupErr) {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createBackup(filePath, timestamp) {
  if (!fs.existsSync(filePath)) return null;
  const target = `${filePath}.bak-${timestamp}`;
  fs.copyFileSync(filePath, target);
  return target;
}

/**
 * Applies or refreshes the gpt-oauth registration.
 *
 * @param {object} [options]
 * @param {string} [options.home]  Home directory to operate on (default os.homedir()).
 * @param {Date}   [options.now]   Clock used for backup timestamps (default now).
 * @returns {object} summary containing only paths, the provider id and model id lists.
 */
function runSetup(options = {}) {
  const home = path.resolve(options.home || os.homedir());
  const now = options.now instanceof Date ? options.now : new Date();
  const timestamp = localTimestamp(now);

  let stat;
  try {
    stat = fs.statSync(home);
  } catch (err) {
    throw new SetupError(`home directory does not exist: ${home}`);
  }
  if (!stat.isDirectory()) throw new SetupError(`home path is not a directory: ${home}`);

  const paths = {
    providerConfig: providerConfigPathFor(home),
    legacyConfig: legacyConfigPathFor(home),
    providerUuid: providerUuidPathFor(home),
  };

  // ---- read + validate everything before any write happens ----
  const providerRead = readJsonFileIfExists(paths.providerConfig);
  if (providerRead.exists) assertSchemaVersion(providerRead.value, paths.providerConfig);

  const legacyRead = readJsonFileIfExists(paths.legacyConfig);
  if (legacyRead.exists && !isPlainObject(legacyRead.value)) {
    throw new SetupError(`${paths.legacyConfig}: expected a JSON object at the top level`);
  }

  const storedProviderId = resolveProviderId(home);
  const providerDraft = providerRead.exists ? cloneJson(providerRead.value) : emptyProviderConfig();
  const providerMerge = mergeProviderConfig(providerDraft, storedProviderId, {
    filePath: paths.providerConfig,
  });
  const providerId = providerMerge.providerId;

  const legacyDraft = legacyRead.exists ? cloneJson(legacyRead.value) : { provider: {} };
  const legacyMerge = mergeLegacyConfig(legacyDraft, providerId, { filePath: paths.legacyConfig });

  // ---- write phase ----
  const createdFiles = [];
  const updatedFiles = [];
  const unchangedFiles = [];
  const backups = [];

  const commitJson = (filePath, read, draft) => {
    if (!read.exists) {
      writeJsonAtomic(filePath, draft);
      createdFiles.push(filePath);
      return;
    }
    if (JSON.stringify(read.value) === JSON.stringify(draft)) {
      unchangedFiles.push(filePath);
      return;
    }
    const backup = createBackup(filePath, timestamp);
    if (backup) backups.push(backup);
    writeJsonAtomic(filePath, draft);
    updatedFiles.push(filePath);
  };

  commitJson(paths.providerConfig, providerRead, providerMerge.draft);
  commitJson(paths.legacyConfig, legacyRead, legacyMerge.draft);

  const uuidContent = `${providerId}\n`;
  let uuidCurrent = null;
  try {
    uuidCurrent = fs.readFileSync(paths.providerUuid, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  if (uuidCurrent !== uuidContent) {
    if (uuidCurrent !== null) {
      const backup = createBackup(paths.providerUuid, timestamp);
      if (backup) backups.push(backup);
      updatedFiles.push(paths.providerUuid);
    } else {
      createdFiles.push(paths.providerUuid);
    }
    writeFileAtomic(paths.providerUuid, uuidContent);
  } else {
    unchangedFiles.push(paths.providerUuid);
  }

  return {
    home,
    providerId,
    timestamp,
    paths,
    addedModelIds: providerMerge.addedModelIds,
    addedProviderModelRuleIds: providerMerge.addedModelRuleIds,
    addedLegacyModelIds: legacyMerge.addedModelIds,
    providerRuleCreated: providerMerge.ruleCreated,
    legacyEntryCreated: legacyMerge.entryCreated,
    createdFiles,
    updatedFiles,
    unchangedFiles,
    backups,
  };
}

function formatSummary(summary) {
  const list = (ids) => (ids.length === 0 ? '(none)' : ids.join(', '));
  return [
    `home: ${summary.home}`,
    `provider id: ${summary.providerId}`,
    `provider config: ${summary.paths.providerConfig}`,
    `legacy config: ${summary.paths.legacyConfig}`,
    `provider uuid: ${summary.paths.providerUuid}`,
    `added model ids (${summary.addedModelIds.length}): ${list(summary.addedModelIds)}`,
    `added model rules (${summary.addedProviderModelRuleIds.length}): ${list(summary.addedProviderModelRuleIds)}`,
    `added legacy model ids (${summary.addedLegacyModelIds.length}): ${list(summary.addedLegacyModelIds)}`,
    `created files: ${list(summary.createdFiles)}`,
    `updated files: ${list(summary.updatedFiles)}`,
    `backups: ${list(summary.backups)}`,
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { home: os.homedir(), help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--home') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new SetupError('--home requires a directory path');
      opts.home = value;
      i += 1;
    } else if (arg.startsWith('--home=')) {
      const value = arg.slice('--home='.length);
      if (!value) throw new SetupError('--home requires a directory path');
      opts.home = value;
    } else {
      throw new SetupError(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      stdout.write('usage: node scripts/setup-provider.js [--home <path>]\n');
      return 0;
    }
    const summary = runSetup({ home: opts.home });
    stdout.write(`${formatSummary(summary)}\n`);
    return 0;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    stderr.write(`setup-provider: error: ${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  // constants
  SCHEMA_VERSION,
  PROVIDER_NAME,
  PROVIDER_KIND,
  PROVIDER_SOURCE,
  PROVIDER_GROUP,
  API_KEY_LITERAL,
  API_TYPE,
  BASE_URL,
  GPT_MODEL_IDS,
  GROK_MODEL_IDS,
  ALL_MODEL_IDS,
  PROVIDER_MODEL_RULES,
  LEGACY_MODEL_SPECS,
  SetupError,
  // helpers
  isPlainObject,
  cloneJson,
  zcodeV2Dir,
  providerStateDir,
  providerConfigPathFor,
  legacyConfigPathFor,
  providerUuidPathFor,
  localTimestamp,
  resolveProviderId,
  emptyProviderConfig,
  readJsonFileIfExists,
  assertSchemaVersion,
  mergeProviderConfig,
  mergeLegacyConfig,
  writeFileAtomic,
  writeJsonAtomic,
  createBackup,
  runSetup,
  formatSummary,
  parseArgs,
  main,
};
