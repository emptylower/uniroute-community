import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { parse as parseToml } from 'smol-toml';
import { parse as parseJsonc } from 'jsonc-parser';
import JSON5 from 'json5';
import { parse as parseYaml } from 'yaml';
import { fetchCatalog, selectModel, inferProtocol, normalizeBaseUrl, protocolDefinition, groupCatalog } from '../src/catalog.js';
import { configureClient, doctor } from '../src/configure.js';
import { readProtectedKey, assertSafePath, readConfig, writeConfigs } from '../src/files.js';
import { run, parseArgs } from '../src/cli.js';

const sandbox = process.env.UNIROUTE_TEST_ROOT
  ? path.resolve(process.env.UNIROUTE_TEST_ROOT)
  : await fs.realpath(os.tmpdir());
const key = 'test-private-key-never-print';
const modelRows = [
  { id: 'claude-sonnet-test', name: 'Claude' }, { id: 'gpt-test', name: 'GPT' },
  { id: 'gemini-test', display_name: 'Gemini' }, { id: 'deepseek-test', name: 'DeepSeek' }, { id: 'unknown-test' },
];

async function fixture(t, handler) {
  await fs.mkdir(sandbox, { recursive: true });
  const home = await fs.mkdtemp(path.join(sandbox, 'uniroute-setup-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    if (handler) handler(req, res);
    else {
      assert.equal(req.url, '/v1/models');
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: modelRows }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function write(relative, source, mode = 0o600) {
    const file = path.join(home, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source, { mode });
  }
  const read = relative => fs.readFile(path.join(home, relative), 'utf8');
  const catalog = () => fetchCatalog({ baseUrl, apiKey: key });
  return { home, baseUrl, write, read, requests, catalog };
}

test('authenticated live catalog normalizes records and explicit unknown protocols', async t => {
  const f = await fixture(t);
  const catalog = await f.catalog();
  assert.equal(catalog.length, 5);
  assert.equal(catalog[0].protocol, 'anthropic');
  assert.equal(catalog[2].name, 'Gemini');
  assert.equal(catalog[4].protocol, null);
  assert.throws(() => selectModel(catalog, 'made-up'), /absent/);
  assert.throws(() => selectModel(catalog, 'unknown-test'), /Unknown/);
  assert.equal(selectModel(catalog, 'unknown-test', 'openai-chat').protocol, 'openai-chat');
  assert.equal(groupCatalog(catalog, f.baseUrl).length, 4);
  assert.equal(inferProtocol('vendor/gpt-6-sol'), 'openai-responses');
  assert.equal(inferProtocol('flux-image'), null);
});

test('protocol URLs use correct native suffixes and reject insecure or credential-bearing roots', () => {
  const root = 'https://api.all-model-router.app';
  assert.equal(normalizeBaseUrl(`${root}/v1/`), root);
  assert.equal(protocolDefinition('anthropic', root).openclawBaseUrl, root);
  assert.equal(protocolDefinition('anthropic', root).opencodeBaseUrl, `${root}/v1`);
  assert.equal(protocolDefinition('gemini', root).opencodeBaseUrl, `${root}/v1beta`);
  assert.equal(protocolDefinition('gemini', root).openclawBaseUrl, `${root}/v1beta`);
  assert.equal(protocolDefinition('openai-chat', root).openclawApi, 'openai-completions');
  for (const unsafe of ['http://example.com', 'https://secret@example.com', 'https://example.com/?key=secret', 'ftp://localhost']) assert.throws(() => normalizeBaseUrl(unsafe));
});

test('Claude JSON merges env, preserves unrelated settings, rotates key, secures backup, is idempotent', async t => {
  const f = await fixture(t);
  const original = JSON.stringify({ env: { OTHER: 'keep', ANTHROPIC_API_KEY: 'old' }, permissions: { allow: ['Read'] } }, null, 2);
  await f.write('.claude/settings.json', original, 0o644);
  const model = selectModel(await f.catalog(), 'claude-sonnet-test');
  const changes = await configureClient({ ...f, client: 'claude', model, apiKey: key });
  const settings = JSON.parse(await f.read('.claude/settings.json'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, f.baseUrl);
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, key);
  assert.equal(settings.env.OTHER, 'keep');
  assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(settings.permissions.allow, ['Read']);
  const backup = path.join(f.home, '.claude', changes[0].backup);
  assert.equal(await fs.readFile(backup, 'utf8'), original);
  assert.equal((await fs.stat(backup)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(f.home, '.claude/settings.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await configureClient({ ...f, client: 'claude', model, apiKey: key }), []);
  await configureClient({ ...f, client: 'claude', model, apiKey: 'rotated-key' });
  assert.equal(JSON.parse(await f.read('.claude/settings.json')).env.ANTHROPIC_AUTH_TOKEN, 'rotated-key');
});

test('Codex TOML and auth preserve unrelated providers but switch active OAuth to API key', async t => {
  const f = await fixture(t);
  await f.write('.codex/config.toml', 'model = "old"\n[features]\nweb_search = true\n[model_providers.other]\nbase_url = "https://other.example/v1"\n[model_providers.uniroute.auth]\ncommand = "old-command"\n');
  await f.write('.codex/auth.json', JSON.stringify({ tokens: { access_token: 'old-oauth' }, last_refresh: 'old', extension: 'keep' }));
  await configureClient({ ...f, client: 'codex', model: selectModel(await f.catalog(), 'gpt-test'), apiKey: key });
  const config = parseToml(await f.read('.codex/config.toml'));
  const auth = JSON.parse(await f.read('.codex/auth.json'));
  assert.equal(config.model, 'gpt-test');
  assert.equal(config.model_provider, 'uniroute');
  assert.equal(config.cli_auth_credentials_store, 'file');
  assert.equal(config.model_providers.uniroute.base_url, `${f.baseUrl}/v1`);
  assert.equal(config.model_providers.uniroute.wire_api, 'responses');
  assert.equal(config.model_providers.uniroute.auth, undefined);
  assert.equal(config.features.web_search, true);
  assert.equal(config.model_providers.other.base_url, 'https://other.example/v1');
  assert.equal(auth.OPENAI_API_KEY, key);
  assert.equal(auth.auth_mode, 'apikey');
  assert.equal(auth.tokens, undefined);
  assert.equal(auth.extension, 'keep');
});

test('Gemini merges current auth settings and dotenv without losing other values', async t => {
  const f = await fixture(t);
  await f.write('.gemini/settings.json', '{"ui":{"theme":"dark"},"security":{"auth":{"selectedType":"oauth-personal"}}}');
  await f.write('.gemini/.env', '# keep comment\nOTHER=keep\nGEMINI_API_KEY="old"\nGEMINI_API_KEY="duplicate"\n');
  await configureClient({ ...f, client: 'gemini', model: selectModel(await f.catalog(), 'gemini-test'), apiKey: key });
  const config = JSON.parse(await f.read('.gemini/settings.json'));
  const env = await f.read('.gemini/.env');
  assert.equal(config.ui.theme, 'dark');
  assert.equal(config.security.auth.selectedType, 'gemini-api-key');
  assert.match(env, /# keep comment\nOTHER=keep/);
  assert.match(env, new RegExp(`GOOGLE_GEMINI_BASE_URL="${f.baseUrl}"`));
  assert.match(env, /GEMINI_MODEL="gemini-test"/);
  assert.equal(env.match(/GEMINI_API_KEY=/g).length, 1);
});

test('OpenCode JSONC keeps comments/providers/models and routes all four native SDKs', async t => {
  const f = await fixture(t);
  await f.write('.config/opencode/opencode.jsonc', '{\n// user comment\n"plugin":["existing-plugin"],"provider":{"other":{"models":{"old":{"name":"Keep"}}}},\n}');
  const catalog = await f.catalog();
  for (const id of ['claude-sonnet-test', 'gpt-test', 'deepseek-test', 'gemini-test']) {
    const model = selectModel(catalog, id);
    await configureClient({ ...f, client: 'opencode', model, apiKey: key });
    const source = await f.read('.config/opencode/opencode.jsonc');
    const config = parseJsonc(source);
    const provider = config.provider[`uniroute-${model.protocol}`];
    const definition = protocolDefinition(model.protocol, f.baseUrl);
    assert.match(source, /\/\/ user comment/);
    assert.deepEqual(config.plugin, ['existing-plugin']);
    assert.equal(config.provider.other.models.old.name, 'Keep');
    assert.equal(provider.npm, definition.opencodePackage);
    assert.equal(provider.options.baseURL, definition.opencodeBaseUrl);
    assert.equal(provider.models[id].name, model.name);
  }
  const config = parseJsonc(await f.read('.config/opencode/opencode.jsonc'));
  assert.equal(Object.keys(config.provider).length, 5);
  assert.equal(config.model, 'uniroute-gemini/gemini-test');
});

test('OpenCode honors an existing JSON config and refuses ambiguous dual files', async t => {
  const f = await fixture(t);
  await f.write('.config/opencode/opencode.json', '{"theme":"keep"}');
  const model = selectModel(await f.catalog(), 'gpt-test');
  await configureClient({ ...f, client: 'opencode', model, apiKey: key });
  assert.equal(JSON.parse(await f.read('.config/opencode/opencode.json')).theme, 'keep');
  await assert.rejects(f.read('.config/opencode/opencode.jsonc'), { code: 'ENOENT' });
  await f.write('.config/opencode/opencode.jsonc', '{}');
  await assert.rejects(configureClient({ ...f, client: 'opencode', model, apiKey: key }), /Both OpenCode/);
});

test('OpenClaw JSON5 keeps unrelated providers, old models, defaults and adds no imaginary capabilities', async t => {
  const f = await fixture(t);
  await f.write('.openclaw/openclaw.json', "{gateway:{port:18789},models:{providers:{other:{models:[{id:'old',name:'Keep'}]}}},agents:{defaults:{model:{primary:'other/old',fallbacks:['other/old']}}}}");
  const catalog = await f.catalog();
  for (const id of ['claude-sonnet-test', 'gpt-test', 'deepseek-test', 'gemini-test']) {
    const model = selectModel(catalog, id);
    await configureClient({ ...f, client: 'openclaw', model, apiKey: key });
    const config = JSON5.parse(await f.read('.openclaw/openclaw.json'));
    const provider = config.models.providers[`uniroute-${model.protocol}`];
    assert.equal(provider.api, protocolDefinition(model.protocol, f.baseUrl).openclawApi);
    assert.equal(provider.baseUrl, protocolDefinition(model.protocol, f.baseUrl).openclawBaseUrl);
    assert.deepEqual(provider.models[0], { id, name: model.name });
    assert.equal(config.gateway.port, 18789);
    assert.deepEqual(config.agents.defaults.model.fallbacks, ['other/old']);
    assert.equal(config.models.providers.other.models[0].name, 'Keep');
  }
});

test('Hermes YAML uses current providers dict, retains comments and uses exact transport', async t => {
  const f = await fixture(t);
  await f.write('.hermes/config.yaml', '# user comment\nmodel:\n  provider: old\n  default: old\n  base_url: https://old.example\nproviders:\n  other:\n    api: https://keep.example/v1\nagent:\n  max_turns: 10\n');
  await f.write('.hermes/.env', '# keep\nOTHER=keep\n');
  const catalog = await f.catalog();
  for (const id of ['claude-sonnet-test', 'gpt-test', 'deepseek-test']) {
    const model = selectModel(catalog, id);
    await configureClient({ ...f, client: 'hermes', model, apiKey: key });
    const source = await f.read('.hermes/config.yaml');
    const config = parseYaml(source);
    assert.match(source, /# user comment/);
    assert.equal(config.model.provider, `uniroute-${model.protocol}`);
    assert.equal(config.model.base_url, undefined);
    assert.equal(config.providers[config.model.provider].transport, protocolDefinition(model.protocol, f.baseUrl).hermesTransport);
    assert.equal(config.providers[config.model.provider].api, protocolDefinition(model.protocol, f.baseUrl).hermesBaseUrl);
    assert.equal(config.agent.max_turns, 10);
    assert.equal(config.providers.other.api, 'https://keep.example/v1');
  }
  await assert.rejects(configureClient({ ...f, client: 'hermes', model: selectModel(catalog, 'gemini-test'), apiKey: key }), /Native Gemini/);
  assert.match(await f.read('.hermes/.env'), /OTHER=keep/);
});

test('dry run lists only files without writing, creating directories or leaking secrets', async t => {
  const f = await fixture(t);
  const nonexistent = path.join(f.home, 'new-home');
  let output = '';
  await run(['configure', 'codex', '--home', nonexistent, '--base-url', f.baseUrl, '--model', 'gpt-test', '--dry-run', '--json'], { env: { UNIROUTE_API_KEY: key }, output: { write: text => { output += text; } } });
  assert.match(output, /would update/);
  assert.ok(!output.includes(key));
  await assert.rejects(fs.stat(nonexistent), { code: 'ENOENT' });
});

test('malformed configs and incompatible protocols cause zero writes across multiple files', async t => {
  const f = await fixture(t);
  await f.write('.codex/config.toml', 'model = "keep"\n');
  await f.write('.codex/auth.json', '{broken');
  const model = selectModel(await f.catalog(), 'gpt-test');
  await assert.rejects(configureClient({ ...f, client: 'codex', model, apiKey: key }), /Invalid JSON/);
  assert.equal(await f.read('.codex/config.toml'), 'model = "keep"\n');
  assert.equal((await fs.readdir(path.join(f.home, '.codex'))).length, 2);
  await assert.rejects(configureClient({ ...f, client: 'claude', model, apiKey: key }), /requires anthropic/);
  await assert.rejects(fs.stat(path.join(f.home, '.claude')), { code: 'ENOENT' });
});

test('invalid JSONC/TOML/YAML/dotenv/JSON5 and incompatible object shape are rejected', async t => {
  const cases = [
    ['opencode', '.config/opencode/opencode.jsonc', '{"a":1,"a":2}', 'gpt-test'],
    ['codex', '.codex/config.toml', 'model = [', 'gpt-test'],
    ['hermes', '.hermes/config.yaml', 'model: [', 'gpt-test'],
    ['gemini', '.gemini/.env', 'GEMINI_API_KEY="unterminated', 'gemini-test'],
    ['openclaw', '.openclaw/openclaw.json', '{bad', 'gpt-test'],
    ['claude', '.claude/settings.json', '{"env":[]}', 'claude-sonnet-test'],
  ];
  for (const [client, relative, source, id] of cases) {
    const f = await fixture(t);
    await f.write(relative, source);
    await assert.rejects(configureClient({ ...f, client, model: selectModel(await f.catalog(), id), apiKey: key }));
    assert.equal(await f.read(relative), source);
  }
});

test('401, 403 balance, 429, invalid JSON/catalog and timeout fail without local writes or key leakage', async t => {
  const cases = [
    [401, '{"error":"secret"}', /Authentication/], [403, '{"error":"balance"}', /balance.*not an empty/],
    [429, '', /Rate limit/], [200, '{invalid', /invalid JSON/], [200, '{"data":[]}', /no models/],
    [200, '{"data":[{"id":"bad\\nline"}]}', /invalid model/], [200, '{}', /data array/],
  ];
  for (const [status, body, match] of cases) {
    const f = await fixture(t, (_req, res) => { res.writeHead(status); res.end(body); });
    await assert.rejects(run(['configure', 'codex', '--home', f.home, '--base-url', f.baseUrl, '--model', 'gpt-test'], { env: { UNIROUTE_API_KEY: key }, output: { write() { assert.fail('No output expected on discovery failure'); } } }), match);
    assert.deepEqual(await fs.readdir(f.home), []);
  }
  const slow = await fixture(t, () => {});
  await assert.rejects(fetchCatalog({ baseUrl: slow.baseUrl, apiKey: key, timeoutMs: 10 }), /timed out/);
});

test('symlinks, hard links, path traversal and insecure key files cannot modify external files', async t => {
  const f = await fixture(t);
  const external = path.join(f.home, 'external');
  await fs.mkdir(external);
  await fs.symlink(external, path.join(f.home, '.claude'));
  const model = selectModel(await f.catalog(), 'claude-sonnet-test');
  await assert.rejects(configureClient({ ...f, client: 'claude', model, apiKey: key }), /symlink/);
  assert.deepEqual(await fs.readdir(external), []);
  await assert.rejects(assertSafePath(f.home, path.join(f.home, '..', 'escape')), /inside/);
  await f.write('private-key', key, 0o600);
  assert.equal(await readProtectedKey(path.join(f.home, 'private-key')), key);
  await fs.chmod(path.join(f.home, 'private-key'), 0o644);
  await assert.rejects(readProtectedKey(path.join(f.home, 'private-key')), /private/);
  await fs.chmod(path.join(f.home, 'private-key'), 0o600);
  await fs.link(path.join(f.home, 'private-key'), path.join(f.home, 'linked-key'));
  await assert.rejects(readProtectedKey(path.join(f.home, 'private-key')), /links/);
});

test('doctor is offline, excludes credentials and reports unsafe file permissions', async t => {
  const f = await fixture(t);
  const model = selectModel(await f.catalog(), 'gpt-test');
  await configureClient({ ...f, client: 'codex', model, apiKey: key });
  const before = f.requests.length;
  assert.equal((await doctor({ home: f.home, client: 'codex' }))[0].status, 'local config ready');
  assert.equal(f.requests.length, before);
  await fs.chmod(path.join(f.home, '.codex/auth.json'), 0o644);
  const result = await doctor({ home: f.home, client: 'codex' });
  assert.equal(result[0].status, 'needs configuration');
  assert.ok(!JSON.stringify(result).includes(key));
});

test('actual CLI subprocess exits correctly, lists catalog and key-file supports unattended setup', async t => {
  const f = await fixture(t);
  await f.write('key', key);
  const args = ['configure', 'opencode', '--home', f.home, '--base-url', f.baseUrl, '--model', 'gpt-test', '--key-file', path.join(f.home, 'key')];
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '../src/cli.js'), ...args], { env: { PATH: process.env.PATH } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0, output);
  assert.match(output, /Configured opencode/);
  assert.ok(!output.includes(key));
  assert.equal((await doctor({ home: f.home, client: 'opencode' }))[0].status, 'local config ready');
  assert.throws(() => parseArgs(['--api-key', key]), /Unknown option/);
  assert.throws(() => parseArgs(['--timeout-ms', 'NaN']), /timeout-ms/);
});

test('all clients are idempotent after configuration and doctor recognizes each generated format', async t => {
  const f = await fixture(t);
  const catalog = await f.catalog();
  for (const [client, id] of [['claude', 'claude-sonnet-test'], ['codex', 'gpt-test'], ['gemini', 'gemini-test'], ['opencode', 'gpt-test'], ['openclaw', 'gpt-test'], ['hermes', 'gpt-test']]) {
    const options = { ...f, client, model: selectModel(catalog, id), apiKey: key };
    await configureClient(options);
    assert.deepEqual(await configureClient(options), [], `${client} should be idempotent`);
    assert.equal((await doctor({ home: f.home, client }))[0].status, 'local config ready');
  }
});

test('catalog cannot echo a credential or inject prototype fields into config', async t => {
  for (const id of [key, '__proto__', 'constructor', 'prototype']) {
    const f = await fixture(t, (_req, res) => res.end(JSON.stringify({ data: [{ id }] })));
    await assert.rejects(f.catalog(), /invalid model ID/);
    assert.deepEqual(await fs.readdir(f.home), []);
  }
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify({ data: [{ id: 'gpt-test', name: `Name ${key}` }] })));
  const catalog = await f.catalog();
  assert.ok(!catalog[0].name.includes(key));
  assert.throws(() => selectModel(catalog, 'other'), /absent/);
});

test('hard-linked config files and symlinked homes are rejected before writes', async t => {
  const f = await fixture(t);
  await f.write('.claude/settings.json', '{}');
  await fs.link(path.join(f.home, '.claude/settings.json'), path.join(f.home, 'hardlink'));
  const model = selectModel(await f.catalog(), 'claude-sonnet-test');
  await assert.rejects(configureClient({ ...f, client: 'claude', model, apiKey: key }), /hard links/);
  assert.equal(await f.read('hardlink'), '{}');
  const linkedHome = path.join(f.home, 'home-link');
  await fs.symlink(f.home, linkedHome);
  await assert.rejects(configureClient({ ...f, home: linkedHome, client: 'codex', model: selectModel(await f.catalog(), 'gpt-test'), apiKey: key }), /symlink/);
});

test('Windows does not rewrite unchanged config solely for POSIX mode bits', async t => {
  const f = await fixture(t);
  await f.write('.claude/settings.json', '{}\n', 0o644);
  const config = await readConfig(f.home, '.claude/settings.json', 'json');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    assert.deepEqual(await writeConfigs(f.home, [{ ...config, output: config.source }]), []);
  } finally { Object.defineProperty(process, 'platform', platform); }
  assert.deepEqual(await fs.readdir(path.join(f.home, '.claude')), ['settings.json']);
});

test('npm/npx-style bin symlink runs help and authenticated commands instead of exiting silently', async t => {
  const f = await fixture(t);
  const bin = path.join(f.home, 'node_modules/.bin/uniroute-setup');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.symlink(path.join(import.meta.dirname, '../src/cli.js'), bin);
  async function invoke(args) {
    const child = spawn(process.execPath, [bin, ...args], { cwd: f.home, env: { ...process.env, UNIROUTE_API_KEY: key } });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const code = await new Promise(resolve => child.once('close', resolve));
    assert.equal(code, 0, errors);
    return output;
  }
  assert.match(await invoke(['--help']), /uniroute-setup configure/);
  const output = await invoke(['models', '--base-url', f.baseUrl, '--json']);
  assert.equal(JSON.parse(output)[0].id, 'claude-sonnet-test');
  assert.equal(f.requests.length, 1);
  assert.ok(!output.includes(key));
});

test('macOS /var alias plus npm bin symlink still executes the CLI', { skip: process.platform !== 'darwin' }, async t => {
  const temporary = await fs.mkdtemp(path.join(await fs.realpath('/var/tmp'), 'uniroute-bin-alias-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  assert.match(temporary, /^\/private\/var\//, 'macOS temporary root should expose the /var alias for this regression');
  const bin = path.join(temporary, 'node_modules/.bin/uniroute-setup');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.symlink(path.join(import.meta.dirname, '../src/cli.js'), bin);
  const alias = bin.replace(/^\/private\/var\//, '/var/');
  const child = spawn(process.execPath, [alias, '--help'], { cwd: temporary, env: process.env });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 0, errors);
  assert.match(output, /Supply the key via UNIROUTE_API_KEY/);
});

test('hidden prompt is ready for immediate input and restores terminal on errors', async t => {
  const f = await fixture(t);
  for (const mode of ['paste', 'cancel', 'input error', 'input end', 'output error', 'initialize error', 'newline error']) {
    const input = new EventEmitter();
    const output = new EventEmitter();
    input.isTTY = output.isTTY = true;
    input.isRaw = false;
    const rawCalls = [];
    input.setRawMode = value => { input.isRaw = value; rawCalls.push(value); };
    input.resume = () => {};
    input.pause = () => {};
    const signalCounts = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
    output.write = (text, callback) => {
      if (text.includes('API key')) {
        assert.equal(input.isRaw, true, 'no-echo mode must precede prompt output');
        assert.equal(input.listenerCount('data'), 1, 'data listener must precede prompt output');
        if (mode === 'initialize error') throw new Error('Synthetic private output failure');
        if (mode === 'output error') { queueMicrotask(() => output.emit('error', new Error('Synthetic output error'))); return; }
        if (mode === 'input error') { input.emit('error', new Error('Synthetic input error')); return; }
        if (mode === 'input end') { input.emit('end'); return; }
        input.emit('data', Buffer.from(mode === 'cancel' ? '\u0003' : `${key}\n`));
      } else if (callback) queueMicrotask(() => {
        if (mode === 'newline error') {
          callback(new Error('Synthetic output failure'));
          output.emit('error', new Error('Synthetic output failure'));
        } else callback();
      });
    };
    const operation = run(['models', '--base-url', f.baseUrl], { env: {}, input, output });
    if (mode === 'paste') await operation;
    else await assert.rejects(operation);
    assert.equal(input.isRaw, false, `${mode}: terminal raw state restored`);
    assert.deepEqual(rawCalls, [true, false]);
    assert.equal(input.listenerCount('data'), 0);
    assert.equal(input.listenerCount('error'), 0);
    assert.equal(input.listenerCount('end'), 0);
    assert.equal(output.listenerCount('error'), 0);
    assert.deepEqual(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal)), signalCounts);
  }
});

test('real PTY immediate paste, Ctrl-C and SIGTERM keep keys hidden and restore termios', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  for (const mode of ['paste', 'cancel', 'signal']) {
    const child = spawn('python3', [path.join(import.meta.dirname, 'pty_prompt.py'), process.execPath,
      path.join(import.meta.dirname, '../src/cli.js'), f.baseUrl, mode], { cwd: f.home });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const code = await new Promise(resolve => child.once('close', resolve));
    assert.equal(code, 0, errors);
    const result = JSON.parse(output);
    assert.equal(result.prompt_seen, true, mode);
    assert.equal(result.no_echo_at_prompt, true, mode);
    assert.equal(result.key_not_echoed, true, mode);
    assert.equal(result.terminal_restored, true, mode);
    if (mode === 'paste') {
      assert.equal(result.exit_code, 0);
      assert.equal(result.catalog_returned, true);
    } else {
      assert.equal(result.exit_code, 1);
      assert.equal(result.cancelled, true);
    }
  }
  assert.equal(f.requests.length, 1, 'cancelled prompts must not call the gateway');
});
