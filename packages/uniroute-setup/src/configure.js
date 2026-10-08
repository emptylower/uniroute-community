import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeBaseUrl, validateApiKey, protocolDefinition, PROTOCOLS } from './catalog.js';
import { readConfig, patchConfig, writeConfigs } from './files.js';

export const CLIENTS = ['claude', 'codex', 'gemini', 'opencode', 'openclaw', 'hermes'];
const paths = {
  claude: [['.claude/settings.json', 'json']],
  codex: [['.codex/config.toml', 'toml'], ['.codex/auth.json', 'json']],
  gemini: [['.gemini/settings.json', 'json'], ['.gemini/.env', 'env']],
  openclaw: [['.openclaw/openclaw.json', 'json5']],
  hermes: [['.hermes/config.yaml', 'yaml'], ['.hermes/.env', 'env']],
};

async function clientPaths(home, client) {
  if (client !== 'opencode') return paths[client];
  const jsonc = '.config/opencode/opencode.jsonc';
  const json = '.config/opencode/opencode.json';
  async function exists(relative) {
    try { await fs.lstat(path.join(home, relative)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  const hasJsonc = await exists(jsonc), hasJson = await exists(json);
  if (hasJsonc && hasJson) throw new Error('Both OpenCode JSON and JSONC configs exist. Consolidate them before configuring UniRoute.');
  return [[hasJson ? json : jsonc, hasJson ? 'json' : 'jsonc']];
}

function verifyClient(client, model) {
  if (!CLIENTS.includes(client)) throw new Error(`Client must be one of: ${CLIENTS.join(', ')}.`);
  if (!model || typeof model.id !== 'string' || !model.id || /[\x00-\x20\x7f]/.test(model.id) || ['__proto__', 'constructor', 'prototype'].includes(model.id) || !PROTOCOLS.includes(model.protocol)) throw new Error('A validated catalog model and protocol are required.');
  const required = { claude: 'anthropic', codex: 'openai-responses', gemini: 'gemini' }[client];
  if (required && model.protocol !== required) throw new Error(`${client} requires ${required}; choose a compatible catalog model.`);
  if (client === 'hermes' && model.protocol === 'gemini') throw new Error('Native Gemini routing is not supported by this Hermes custom-provider adapter. Choose a confirmed chat, Responses or Anthropic route.');
}

export async function configureClient({ home, client, model, apiKey, baseUrl, dryRun = false }) {
  verifyClient(client, model);
  validateApiKey(apiKey);
  const root = normalizeBaseUrl(baseUrl);
  const definition = protocolDefinition(model.protocol, root);
  const configs = [];
  for (const [relative, format] of await clientPaths(home, client)) configs.push(await readConfig(home, relative, format));
  const provider = `uniroute-${model.protocol}`;
  let changes;
  switch (client) {
    case 'claude':
      changes = [[
        [['env', 'ANTHROPIC_BASE_URL'], root], [['env', 'ANTHROPIC_AUTH_TOKEN'], apiKey],
        // An API-key variable can compete with AUTH_TOKEN in existing installations.
        [['env', 'ANTHROPIC_API_KEY'], undefined], [['model'], model.id],
      ]];
      break;
    case 'codex':
      changes = [[
        [['model'], model.id], [['model_provider'], 'uniroute'], [['cli_auth_credentials_store'], 'file'],
        [['model_providers', 'uniroute', 'name'], 'UniRoute'], [['model_providers', 'uniroute', 'base_url'], `${root}/v1`],
        [['model_providers', 'uniroute', 'wire_api'], 'responses'], [['model_providers', 'uniroute', 'requires_openai_auth'], true],
        [['model_providers', 'uniroute', 'env_key'], undefined], [['model_providers', 'uniroute', 'experimental_bearer_token'], undefined],
        [['model_providers', 'uniroute', 'auth'], undefined],
      ], [
        [['OPENAI_API_KEY'], apiKey], [['auth_mode'], 'apikey'], [['tokens'], undefined], [['last_refresh'], undefined],
      ]];
      break;
    case 'gemini':
      changes = [[ [['security', 'auth', 'selectedType'], 'gemini-api-key'] ], [
        [['GEMINI_API_KEY'], apiKey], [['GOOGLE_GEMINI_BASE_URL'], root], [['GEMINI_MODEL'], model.id],
      ]];
      break;
    case 'opencode':
      changes = [[
        [['provider', provider, 'npm'], definition.opencodePackage], [['provider', provider, 'name'], 'UniRoute'],
        [['provider', provider, 'options', 'baseURL'], definition.opencodeBaseUrl], [['provider', provider, 'options', 'apiKey'], apiKey],
        [['provider', provider, 'models', model.id, 'name'], model.name || model.id], [['model'], `${provider}/${model.id}`],
      ]];
      break;
    case 'openclaw': {
      const existing = configs[0].value.models?.providers?.[provider]?.models;
      if (existing !== undefined && !Array.isArray(existing)) throw new Error('OpenClaw provider models must be an array.');
      const models = [...(existing || [])];
      const index = models.findIndex(item => item?.id === model.id);
      const entry = { ...(index >= 0 ? models[index] : {}), id: model.id, name: model.name || model.id };
      if (index >= 0) models[index] = entry; else models.push(entry);
      // Do not invent context windows, token prices or vision/reasoning capabilities.
      changes = [[
        [['models', 'providers', provider, 'baseUrl'], definition.openclawBaseUrl], [['models', 'providers', provider, 'apiKey'], apiKey],
        [['models', 'providers', provider, 'api'], definition.openclawApi], [['models', 'providers', provider, 'models'], models],
        [typeof configs[0].value.agents?.defaults?.model === 'string' ? ['agents', 'defaults', 'model'] : ['agents', 'defaults', 'model', 'primary'],
          typeof configs[0].value.agents?.defaults?.model === 'string' ? { primary: `${provider}/${model.id}` } : `${provider}/${model.id}`],
      ]];
      break;
    }
    case 'hermes':
      changes = [[
        [['providers', provider, 'name'], 'UniRoute'], [['providers', provider, 'api'], definition.hermesBaseUrl],
        [['providers', provider, 'key_env'], 'UNIROUTE_API_KEY'], [['providers', provider, 'transport'], definition.hermesTransport],
        [['providers', provider, 'default_model'], model.id], [['providers', provider, 'api_key'], undefined], [['providers', provider, 'key_cmd'], undefined],
        [['model', 'provider'], provider], [['model', 'default'], model.id], [['model', 'model'], undefined],
        [['model', 'base_url'], undefined], [['model', 'api_key'], undefined], [['model', 'key_env'], undefined], [['model', 'api_mode'], undefined],
      ], [ [['UNIROUTE_API_KEY'], apiKey] ]];
      break;
  }
  const patched = configs.map((config, i) => patchConfig(config, changes[i]));
  return writeConfigs(home, patched, { dryRun });
}

export async function doctor({ home, client }) {
  if (client && !CLIENTS.includes(client)) throw new Error('Unknown client.');
  const results = [];
  for (const name of client ? [client] : CLIENTS) {
    try {
      const configs = [];
      for (const [relative, format] of await clientPaths(home, name)) configs.push(await readConfig(home, relative, format));
      if (configs.every(config => config.source === null)) { results.push({ client: name, status: 'not configured' }); continue; }
      const first = configs[0].value;
      let configured = false;
      switch (name) {
        case 'claude': configured = Boolean(first.env?.ANTHROPIC_BASE_URL && first.env?.ANTHROPIC_AUTH_TOKEN && first.model); break;
        case 'codex': configured = Boolean(first.model_provider === 'uniroute' && first.model && first.model_providers?.uniroute?.base_url && configs[1].value.OPENAI_API_KEY && configs[1].value.auth_mode === 'apikey'); break;
        case 'gemini': configured = Boolean(first.security?.auth?.selectedType === 'gemini-api-key' && configs[1].value.GEMINI_API_KEY && configs[1].value.GOOGLE_GEMINI_BASE_URL && configs[1].value.GEMINI_MODEL); break;
        case 'opencode': {
          const provider = typeof first.model === 'string' ? first.model.split('/')[0] : '';
          configured = Boolean(provider.startsWith('uniroute-') && first.provider?.[provider]?.options?.apiKey && first.provider?.[provider]?.options?.baseURL);
          break;
        }
        case 'openclaw': {
          const provider = typeof first.agents?.defaults?.model?.primary === 'string' ? first.agents.defaults.model.primary.split('/')[0] : '';
          configured = Boolean(provider.startsWith('uniroute-') && first.models?.providers?.[provider]?.apiKey && first.models?.providers?.[provider]?.baseUrl);
          break;
        }
        case 'hermes': configured = Boolean(first.model?.provider?.startsWith('uniroute-') && first.providers?.[first.model.provider]?.key_env === 'UNIROUTE_API_KEY' && configs[1].value.UNIROUTE_API_KEY); break;
      }
      let privateFiles = true;
      for (const config of configs.filter(item => item.source !== null)) if (process.platform !== 'win32' && ((await fs.stat(config.file)).mode & 0o077)) privateFiles = false;
      results.push({ client: name, status: configured && privateFiles ? 'local config ready' : 'needs configuration', privateFiles });
    } catch (error) { results.push({ client: name, status: 'invalid config', reason: error.message }); }
  }
  return results;
}
