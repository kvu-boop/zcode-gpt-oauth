'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const setup = require('../scripts/setup-provider.js');

const {
  ALL_MODEL_IDS,
  GPT_MODEL_IDS,
  GROK_MODEL_IDS,
  PROVIDER_NAME,
  runSetup,
  formatSummary,
  main,
  providerConfigPathFor,
  legacyConfigPathFor,
  providerUuidPathFor,
} = setup;

const OTHER_PROVIDER_ID = 'bd212e3d-b51d-4cd1-8812-df316ce1065a';
// Fake secret used to prove nothing echoes other providers' credentials.
const FAKE_SECRET = 'sk-FAKE-SECRET-deepseek-do-not-leak-0001';

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-oauth-setup-'));
}

function paths(home) {
  return {
    providerConfig: providerConfigPathFor(home),
    legacyConfig: legacyConfigPathFor(home),
    providerUuid: providerUuidPathFor(home),
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function gptOauthRule(providerConfig) {
  return providerConfig.config.providerConfigRules.providerRules.find((r) => r.providerName === PROVIDER_NAME);
}

function runSetupError(home) {
  try {
    runSetup({ home });
  } catch (err) {
    return err.message || String(err);
  }
  return '';
}

function gptOauthModelRules(providerConfig, providerId) {
  return providerConfig.config.modelConfigRules.providerModelRules.filter((r) => r.providerId === providerId);
}

function legacyEntry(legacyConfig, providerId) {
  return legacyConfig.provider[providerId];
}

function fixtureProviderConfigGptOnly(providerId) {
  return {
    schemaVersion: 1,
    config: {
      providerOrder: [OTHER_PROVIDER_ID, providerId],
      providerConfigRules: {
        providerRules: [
          {
            providerId: OTHER_PROVIDER_ID,
            providerName: 'deepseek',
            config: {
              group: 'standard-personal',
              access: { type: 'api-key', apiKey: FAKE_SECRET },
              api: { type: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic' },
              personalModelIds: ['deepseek-flash'],
              modelOrder: ['deepseek-flash'],
              unknownFutureField: { keep: ['me'] },
            },
          },
          {
            providerId,
            providerName: PROVIDER_NAME,
            config: {
              group: 'standard-personal',
              access: { type: 'api-key', apiKey: 'local-proxy' },
              api: { type: 'openai-chat-completions', baseUrl: 'http://127.0.0.1:8787/v1' },
              personalModelIds: [...GPT_MODEL_IDS],
              modelOrder: [...GPT_MODEL_IDS],
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          { providerId: OTHER_PROVIDER_ID, modelId: 'deepseek-flash', config: { properties: { contextWindow: 1000000 } } },
          ...GPT_MODEL_IDS.map((modelId) => ({
            providerId,
            modelId,
            config: { properties: { contextWindow: 256000 } },
          })),
        ],
        manualProviderModelRules: [],
      },
    },
  };
}

function fixtureLegacyConfigGptOnly(providerId) {
  return {
    provider: {
      [OTHER_PROVIDER_ID]: {
        name: 'deepseek',
        kind: 'anthropic',
        options: { apiKey: FAKE_SECRET, baseURL: 'https://api.deepseek.com/anthropic', apiKeyRequired: true },
        source: 'custom',
        models: { 'deepseek-flash': { limit: { context: 1000000, output: 384000 } } },
      },
      [providerId]: {
        name: PROVIDER_NAME,
        kind: 'openai-compatible',
        options: { apiKey: 'local-proxy', baseURL: 'http://127.0.0.1:8787/v1', apiKeyRequired: true },
        source: 'custom',
        models: Object.fromEntries(
          GPT_MODEL_IDS.map((id) => [id, { limit: { context: 256000, output: 128000 } }]),
        ),
      },
    },
  };
}

test('1. empty home: creates both registries with schema v1 and legacy shape', () => {
  const home = makeHome();
  const p = paths(home);
  const summary = runSetup({ home });

  assert.equal(fs.existsSync(p.providerConfig), true);
  assert.equal(fs.existsSync(p.legacyConfig), true);
  assert.equal(fs.existsSync(p.providerUuid), true);
  assert.equal(fs.readFileSync(p.providerUuid, 'utf8').trim(), summary.providerId);
  assert.deepEqual(summary.addedModelIds, ALL_MODEL_IDS);
  assert.deepEqual(summary.addedLegacyModelIds, ALL_MODEL_IDS);

  const providerConfig = readJson(p.providerConfig);
  assert.equal(providerConfig.schemaVersion, 1);
  const rule = gptOauthRule(providerConfig);
  assert.equal(rule.providerId, summary.providerId);
  assert.equal(rule.config.group, 'standard-personal');
  assert.equal(rule.config.access.type, 'api-key');
  assert.equal(rule.config.api.type, 'openai-chat-completions');
  assert.equal(rule.config.api.baseUrl, 'http://127.0.0.1:8787/v1');
  assert.deepEqual(rule.config.personalModelIds, ALL_MODEL_IDS);
  assert.deepEqual(rule.config.modelOrder, ALL_MODEL_IDS);
  assert.deepEqual(providerConfig.config.providerOrder, [summary.providerId]);
  assert.deepEqual(providerConfig.config.modelConfigRules.manualProviderModelRules, []);

  const modelRules = gptOauthModelRules(providerConfig, summary.providerId);
  assert.equal(modelRules.length, ALL_MODEL_IDS.length);
  const grok46 = modelRules.find((r) => r.modelId === 'grok-4.6');
  assert.deepEqual(grok46.config, {
    properties: {
      contextWindow: 500000,
      inputFormat: { supportsText: true, supportsImage: true, supportsVideo: false, supportsAudio: false, supportsPdf: false },
    },
    optionSpecs: {
      reasoningLevel: { values: ['low', 'medium', 'high', 'xhigh'] },
      maxOutputTokens: { max: 128000 },
    },
  });
  const grok43 = modelRules.find((r) => r.modelId === 'grok-4.3');
  assert.equal(grok43.config.properties.contextWindow, 1000000);
  assert.equal(grok43.config.optionSpecs.reasoningLevel, undefined);
  assert.deepEqual(grok43.config.optionSpecs.maxOutputTokens, { max: 128000 });
  const grokReasoning = modelRules.find((r) => r.modelId === 'grok-4.20-0309-reasoning');
  assert.deepEqual(grokReasoning.config.optionSpecs, { maxOutputTokens: { max: 30000 } });

  // No legacy shape keys leaked into provider_config.
  const serializedProviderConfig = readText(p.providerConfig);
  assert.equal(serializedProviderConfig.includes('"reasoning"'), false);
  assert.equal(serializedProviderConfig.includes('"modalities"'), false);

  const legacy = readJson(p.legacyConfig);
  const entry = legacyEntry(legacy, summary.providerId);
  assert.equal(entry.name, PROVIDER_NAME);
  assert.equal(entry.kind, 'openai-compatible');
  assert.equal(entry.source, 'custom');
  assert.deepEqual(entry.options, { apiKey: 'local-proxy', baseURL: 'http://127.0.0.1:8787/v1', apiKeyRequired: true });
  assert.deepEqual(Object.keys(entry.models), ALL_MODEL_IDS);
  assert.deepEqual(entry.models['grok-4.6'], {
    reasoning: { enabled: true, variants: ['low', 'medium', 'high', 'xhigh'], defaultVariant: 'high' },
    limit: { context: 500000, output: 500000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  });
  assert.deepEqual(entry.models['grok-4.3'], {
    reasoning: { enabled: true, variants: ['none', 'low', 'medium', 'high'] },
    limit: { context: 1000000, output: 30000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  });
  assert.deepEqual(entry.models['gpt-5.6-sol'], {
    limit: { context: 256000, output: 128000 },
    modalities: { input: ['text', 'image'], output: ['text'] },
  });
});

test('2. existing provider with GPT-only registry gains the six Grok models', () => {
  const home = makeHome();
  const p = paths(home);
  const providerId = '11111111-2222-3333-4444-555555555555';
  writeJson(p.providerConfig, fixtureProviderConfigGptOnly(providerId));
  writeJson(p.legacyConfig, fixtureLegacyConfigGptOnly(providerId));

  const summary = runSetup({ home });

  assert.equal(summary.providerId, providerId);
  assert.deepEqual(summary.addedModelIds, GROK_MODEL_IDS);
  assert.deepEqual(summary.addedProviderModelRuleIds, GROK_MODEL_IDS);
  assert.deepEqual(summary.addedLegacyModelIds, GROK_MODEL_IDS);

  const providerConfig = readJson(p.providerConfig);
  const rule = gptOauthRule(providerConfig);
  // Existing 4 GPT ids keep their position at the front of both lists.
  assert.deepEqual(rule.config.personalModelIds, ALL_MODEL_IDS);
  assert.deepEqual(rule.config.modelOrder, ALL_MODEL_IDS);
  assert.deepEqual(rule.config.personalModelIds.slice(0, 4), GPT_MODEL_IDS);
  assert.deepEqual(providerConfig.config.providerOrder, [OTHER_PROVIDER_ID, providerId]);
  assert.equal(gptOauthModelRules(providerConfig, providerId).length, ALL_MODEL_IDS.length);

  const legacyModels = legacyEntry(readJson(p.legacyConfig), providerId).models;
  assert.deepEqual(Object.keys(legacyModels), ALL_MODEL_IDS);
});

test('3. running twice is idempotent and leaves file content untouched', () => {
  const home = makeHome();
  const p = paths(home);
  const providerId = '11111111-2222-3333-4444-555555555555';
  writeJson(p.providerConfig, fixtureProviderConfigGptOnly(providerId));
  writeJson(p.legacyConfig, fixtureLegacyConfigGptOnly(providerId));

  runSetup({ home });
  const snapshot = {
    providerConfig: readText(p.providerConfig),
    legacyConfig: readText(p.legacyConfig),
    providerUuid: readText(p.providerUuid),
  };
  const backupsAfterFirst = fs.readdirSync(path.dirname(p.providerConfig)).filter((f) => f.includes('.bak-'));

  const second = runSetup({ home });

  assert.deepEqual(second.addedModelIds, []);
  assert.deepEqual(second.addedProviderModelRuleIds, []);
  assert.deepEqual(second.addedLegacyModelIds, []);
  assert.deepEqual(second.createdFiles, []);
  assert.deepEqual(second.updatedFiles, []);
  assert.deepEqual(second.backups, []);
  assert.equal(readText(p.providerConfig), snapshot.providerConfig);
  assert.equal(readText(p.legacyConfig), snapshot.legacyConfig);
  assert.equal(readText(p.providerUuid), snapshot.providerUuid);
  assert.deepEqual(
    fs.readdirSync(path.dirname(p.providerConfig)).filter((f) => f.includes('.bak-')),
    backupsAfterFirst,
  );
});

test('4. unrelated providers, rules, ordering and unknown fields are preserved', () => {
  const home = makeHome();
  const p = paths(home);
  const providerId = '11111111-2222-3333-4444-555555555555';
  const fixtureProviderConfig = fixtureProviderConfigGptOnly(providerId);
  const fixtureLegacy = fixtureLegacyConfigGptOnly(providerId);
  fixtureLegacy.topLevelUnknown = { keep: true };
  fixtureProviderConfig.config.unknownTopLevel = 'keep-me';
  writeJson(p.providerConfig, fixtureProviderConfig);
  writeJson(p.legacyConfig, fixtureLegacy);

  runSetup({ home });

  const providerConfig = readJson(p.providerConfig);
  assert.equal(providerConfig.config.unknownTopLevel, 'keep-me');
  const deepseek = providerConfig.config.providerConfigRules.providerRules.find(
    (r) => r.providerName === 'deepseek',
  );
  assert.deepEqual(deepseek.config, fixtureProviderConfig.config.providerConfigRules.providerRules[0].config);
  assert.equal(deepseek.config.access.apiKey, FAKE_SECRET);
  assert.deepEqual(deepseek.config.unknownFutureField, { keep: ['me'] });
  assert.equal(
    providerConfig.config.modelConfigRules.providerModelRules.filter((r) => r.providerId === OTHER_PROVIDER_ID).length,
    1,
  );

  const legacy = readJson(p.legacyConfig);
  assert.deepEqual(legacy.topLevelUnknown, { keep: true });
  assert.deepEqual(legacy.provider[OTHER_PROVIDER_ID], fixtureLegacy.provider[OTHER_PROVIDER_ID]);
  assert.equal(legacy.provider[OTHER_PROVIDER_ID].options.apiKey, FAKE_SECRET);
});

test('5. existing model rules with local customizations are not overwritten', () => {
  const home = makeHome();
  const p = paths(home);
  const providerId = '11111111-2222-3333-4444-555555555555';
  const providerConfig = fixtureProviderConfigGptOnly(providerId);
  providerConfig.config.modelConfigRules.providerModelRules.push({
    providerId,
    modelId: 'grok-4.6',
    config: {
      properties: { contextWindow: 123, custom: true },
      optionSpecs: { reasoningLevel: { values: ['only-mine'] } },
    },
  });
  writeJson(p.providerConfig, providerConfig);

  const summary = runSetup({ home });

  assert.equal(summary.addedProviderModelRuleIds.includes('grok-4.6'), false);
  const customized = gptOauthModelRules(readJson(p.providerConfig), providerId).find(
    (r) => r.modelId === 'grok-4.6',
  );
  assert.deepEqual(customized.config, {
    properties: { contextWindow: 123, custom: true },
    optionSpecs: { reasoningLevel: { values: ['only-mine'] } },
  });
});

test('6. broken JSON and unsupported schemaVersion fail without writing', () => {
  // (a) malformed provider_config.json
  {
    const home = makeHome();
    const p = paths(home);
    const brokenContent = `{ "schemaVersion": 1, "config": { "providerConfigRules": [ { "apiKey": "${FAKE_SECRET}" } }`;
    fs.mkdirSync(path.dirname(p.providerConfig), { recursive: true });
    fs.writeFileSync(p.providerConfig, brokenContent);

    assert.throws(() => runSetup({ home }), (err) => err.name === 'SetupError' && /invalid JSON/.test(err.message));
    // Content is untouched and no other file was created.
    assert.equal(readText(p.providerConfig), brokenContent);
    assert.equal(fs.existsSync(p.legacyConfig), false);
    assert.equal(fs.existsSync(p.providerUuid), false);
    // The parse error must not echo file content (which could hold secrets).
    assert.equal(String(runSetupError(home)).includes(FAKE_SECRET), false);
  }

  // (b) unsupported schemaVersion
  {
    const home = makeHome();
    const p = paths(home);
    writeJson(p.providerConfig, { schemaVersion: 2, config: {} });
    const before = readText(p.providerConfig);

    assert.throws(() => runSetup({ home }), (err) => err.name === 'SetupError' && /schemaVersion/.test(err.message));
    assert.equal(readText(p.providerConfig), before);
    assert.equal(fs.existsSync(p.legacyConfig), false);
    assert.equal(fs.existsSync(p.providerUuid), false);
  }

  // (c) malformed legacy config.json also refuses to write anything.
  {
    const home = makeHome();
    const p = paths(home);
    fs.mkdirSync(path.dirname(p.legacyConfig), { recursive: true });
    fs.writeFileSync(p.legacyConfig, '{ not json');
    assert.throws(() => runSetup({ home }), (err) => err.name === 'SetupError' && /invalid JSON/.test(err.message));
    assert.equal(readText(p.legacyConfig), '{ not json');
    assert.equal(fs.existsSync(p.providerConfig), false);
  }
});

test('7. a timestamped sibling backup is created when a file already exists', () => {
  const home = makeHome();
  const p = paths(home);
  const providerId = '11111111-2222-3333-4444-555555555555';
  writeJson(p.providerConfig, fixtureProviderConfigGptOnly(providerId));
  writeJson(p.legacyConfig, fixtureLegacyConfigGptOnly(providerId));
  const providerConfigBefore = readText(p.providerConfig);
  const legacyBefore = readText(p.legacyConfig);
  const now = new Date(2026, 8, 21, 15, 4, 5, 0); // 2026-09-21 15:04:05 local

  const summary = runSetup({ home, now });

  assert.equal(summary.timestamp, '20260921150405');
  const providerBackup = `${p.providerConfig}.bak-20260921150405`;
  const legacyBackup = `${p.legacyConfig}.bak-20260921150405`;
  assert.equal(fs.existsSync(providerBackup), true);
  assert.equal(fs.existsSync(legacyBackup), true);
  assert.equal(readText(providerBackup), providerConfigBefore);
  assert.equal(readText(legacyBackup), legacyBefore);
  assert.deepEqual(summary.backups.slice().sort(), [legacyBackup, providerBackup].sort());
  // Same timestamp reused for both backups in one run.
  assert.equal(new Set(summary.backups.map((b) => b.split('.bak-')[1])).size, 1);
  // Files that did not exist yet get no backup.
  assert.deepEqual(summary.createdFiles, [p.providerUuid]);
});

test('8. summary and CLI output never contain other providers secrets', () => {
  const home = makeHome();
  const p = paths(home);
  const providerId = '11111111-2222-3333-4444-555555555555';
  writeJson(p.providerConfig, fixtureProviderConfigGptOnly(providerId));
  writeJson(p.legacyConfig, fixtureLegacyConfigGptOnly(providerId));

  const summary = runSetup({ home });
  const serializedSummary = JSON.stringify(summary);
  assert.equal(serializedSummary.includes(FAKE_SECRET), false);
  assert.equal(formatSummary(summary).includes(FAKE_SECRET), false);

  const chunks = [];
  const errors = [];
  const stdout = { write: (chunk) => chunks.push(String(chunk)) };
  const stderr = { write: (chunk) => errors.push(String(chunk)) };
  // Fresh home so the CLI has something to report.
  const cliHome = makeHome();
  const cliPaths = paths(cliHome);
  writeJson(cliPaths.providerConfig, fixtureProviderConfigGptOnly(providerId));
  writeJson(cliPaths.legacyConfig, fixtureLegacyConfigGptOnly(providerId));
  const exitCode = main(['--home', cliHome], { stdout, stderr });

  assert.equal(exitCode, 0);
  assert.deepEqual(errors, []);
  const output = chunks.join('');
  assert.equal(output.includes(FAKE_SECRET), false);
  assert.equal(output.includes('sk-FAKE'), false);
  // Still reports the useful facts.
  assert.equal(output.includes(providerId), true);
  assert.equal(output.includes(cliPaths.providerConfig), true);
  assert.equal(output.includes(cliPaths.legacyConfig), true);
  assert.equal(output.includes('grok-4.20-0309-non-reasoning'), true);
});

test('9. CLI reports a clear failure (exit code 1) for unsupported schemaVersion', () => {
  const home = makeHome();
  const p = paths(home);
  writeJson(p.providerConfig, { schemaVersion: 7, config: {} });
  const chunks = [];
  const errors = [];

  const exitCode = main(['--home', home], {
    stdout: { write: (c) => chunks.push(String(c)) },
    stderr: { write: (c) => errors.push(String(c)) },
  });

  assert.equal(exitCode, 1);
  assert.equal(chunks.length, 0);
  assert.equal(errors.join('').includes('schemaVersion'), true);
});

test('10. explicit provider id file is reused and unknown CLI args fail', () => {
  const home = makeHome();
  const p = paths(home);
  const providerId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  fs.mkdirSync(path.dirname(p.providerUuid), { recursive: true });
  fs.writeFileSync(p.providerUuid, `${providerId}\n`);

  const summary = runSetup({ home });
  assert.equal(summary.providerId, providerId);
  assert.equal(readJson(p.providerConfig).config.providerOrder.includes(providerId), true);

  assert.equal(main(['--nope'], { stdout: { write() {} }, stderr: { write() {} } }), 1);
  assert.equal(main(['--home'], { stdout: { write() {} }, stderr: { write() {} } }), 1);
  assert.equal(main(['--help'], { stdout: { write() {} }, stderr: { write() {} } }), 0);
});
