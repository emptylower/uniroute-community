import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createUniRouteProvider, PROVIDER_IDS } from '../dist/provider.js';

const sdkRoot = process.env.UNIROUTE_OPENCLAW_SDK_ROOT;
const sdk = {
  ...await import(sdkRoot ? pathToFileURL(`${sdkRoot}/provider-auth.js`).href : 'openclaw/plugin-sdk/provider-auth'),
  ...await import(sdkRoot ? pathToFileURL(`${sdkRoot}/provider-auth-api-key.js`).href : 'openclaw/plugin-sdk/provider-auth-api-key'),
};
const secret = 'test-uniroute-key-never-log';
const rows = ['claude-unit', 'gpt-unit', 'deepseek-unit', 'gemini-unit', 'unknown-unit'].map(id => ({ id }));

async function server(t, handler) {
  const http = createServer(handler);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { http.closeAllConnections(); http.close(resolve); }));
  return `http://127.0.0.1:${http.address().port}`;
}
function catalogContext(config = {}, apiKey = secret) {
  return { config, env: {}, resolveProviderApiKey: provider => {
    assert.equal(provider, 'uniroute');
    return { apiKey };
  } };
}
function authContext(config = {}) {
  return {
    config, opts: { unirouteApiKey: secret }, env: {}, allowSecretRefPrompt: false,
    secretInputMode: 'plaintext', prompter: { note: async () => {}, text: async () => { throw new Error('Unexpected prompt'); } },
    runtime: { log() {}, error() {} },
  };
}

test('real SDK registration is read-only and has native family aliases', () => {
  const frozen = Object.freeze({});
  const provider = createUniRouteProvider(sdk, frozen);
  assert.equal(provider.id, 'uniroute');
  assert.deepEqual(provider.hookAliases, PROVIDER_IDS);
  assert.equal(provider.auth[0].id, 'api-key');
  assert.equal(provider.auth[0].starterModel, undefined);
  assert.equal(provider.staticCatalog, undefined);
});

test('authenticated live discovery selects four native protocols and preserves user metadata', async t => {
  let requests = 0;
  const baseUrl = await server(t, (req, res) => {
    requests++;
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    res.end(JSON.stringify({ data: rows }));
  });
  const config = {
    agents: { defaults: { model: { primary: 'other/model' } } },
    models: { providers: { 'uniroute-anthropic': {
      headers: { 'x-custom': 'preserved' }, models: [{ id: 'claude-unit', contextWindow: 100000, maxTokens: 9000, reasoning: true }, { id: 'user-custom', name: 'Preserve me' }],
    }, unrelated: { models: [{ id: 'keep' }] } } },
  };
  const snapshot = structuredClone(config);
  const provider = createUniRouteProvider(sdk, { baseUrl });
  assert.equal(requests, 0);
  const { providers } = await provider.catalog.run(catalogContext(config));
  assert.equal(requests, 1);
  assert.deepEqual(Object.keys(providers), PROVIDER_IDS);
  assert.equal(providers['uniroute-anthropic'].baseUrl, baseUrl);
  assert.equal(providers['uniroute-openai-responses'].api, 'openai-responses');
  assert.equal(providers['uniroute-openai-chat'].api, 'openai-completions');
  assert.equal(providers['uniroute-gemini'].baseUrl, `${baseUrl}/v1beta`);
  assert.equal(providers['uniroute-anthropic'].models[0].contextWindow, 100000);
  assert.equal(providers['uniroute-anthropic'].models[0].reasoning, true);
  assert.equal(providers['uniroute-anthropic'].models[1].id, 'user-custom');
  assert.deepEqual(providers['uniroute-anthropic'].headers, { 'x-custom': 'preserved' });
  assert.deepEqual(config, snapshot);
  assert.equal(await provider.catalog.run(catalogContext({}, null)), null);
});

test('actual host auth helper captures one profile without changing defaults or persisting directly', async t => {
  const baseUrl = await server(t, (req, res) => res.end(JSON.stringify({ data: rows })));
  const config = { agents: { defaults: { model: { primary: 'existing/model' } } } };
  const snapshot = structuredClone(config);
  const provider = createUniRouteProvider(sdk, { baseUrl });
  const result = await provider.auth[0].run(authContext(config));
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].profileId, 'uniroute:default');
  assert.deepEqual(result.profiles[0].credential, { type: 'api_key', provider: 'uniroute', key: secret });
  assert.deepEqual(Object.keys(result.configPatch.models.providers), PROVIDER_IDS);
  assert.equal(JSON.stringify(result.configPatch).includes(secret), false);
  assert.equal(result.configPatch.agents, undefined);
  assert.equal(result.defaultModel, undefined);
  assert.deepEqual(config, snapshot);
  assert.equal(result.notes.join().includes(secret), false);
});

test('host environment marker stays in model config while the resolved credential authenticates discovery', async t => {
  const baseUrl = await server(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    res.end(JSON.stringify({ data: rows }));
  });
  const result = await createUniRouteProvider(sdk, { baseUrl }).catalog.run({
    config: {}, env: {},
    resolveProviderApiKey: () => ({ apiKey: 'UNIROUTE_API_KEY', discoveryApiKey: secret }),
  });
  assert.equal(result.providers['uniroute-openai-responses'].apiKey, 'UNIROUTE_API_KEY');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('host SecretRef storage input stays a reference after authenticated validation', async t => {
  const baseUrl = await server(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    res.end(JSON.stringify({ data: rows }));
  });
  const ref = { source: 'env', provider: 'default', id: 'UNIROUTE_API_KEY' };
  const context = authContext();
  context.env = { UNIROUTE_API_KEY: secret };
  delete context.opts.unirouteApiKey;
  context.secretInputMode = 'ref';
  context.prompter.select = async () => 'env';
  context.prompter.text = async () => 'UNIROUTE_API_KEY';
  const result = await createUniRouteProvider(sdk, { baseUrl }).auth[0].run(context);
  assert.deepEqual(result.profiles[0].credential.keyRef, ref);
  assert.equal(result.profiles[0].credential.key, undefined);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('auth and discovery surface HTTP failures without credentials/body, before noninteractive persistence', async t => {
  const baseUrl = await server(t, (req, res) => {
    res.writeHead(403); res.end(`private upstream response ${secret}`);
  });
  const provider = createUniRouteProvider(sdk, { baseUrl });
  for (const run of [
    () => provider.catalog.run(catalogContext()),
    () => provider.auth[0].run(authContext()),
    () => provider.auth[0].runNonInteractive({
      config: {}, opts: {}, resolveApiKey: async () => ({ key: secret, source: 'flag' }),
      toApiKeyCredential() { throw new Error('Persistence must not be reached'); },
    }),
  ]) {
    await assert.rejects(run, error => {
      assert.match(error.message, /HTTP 403/);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes('private upstream'), false);
      return true;
    });
  }
});

test('unknown models require explicit protocol and never fabricate a fallback', async t => {
  const baseUrl = await server(t, (req, res) => res.end(JSON.stringify({ data: [{ id: 'custom-unit' }] })));
  await assert.rejects(createUniRouteProvider(sdk, { baseUrl }).catalog.run(catalogContext()), /no recognized text models/);
  const result = await createUniRouteProvider(sdk, { baseUrl, modelProtocols: { 'custom-unit': 'openai-chat' } }).catalog.run(catalogContext());
  assert.equal(result.providers['uniroute-openai-chat'].models[0].id, 'custom-unit');
  assert.equal(result.providers['uniroute-openai-chat'].models[0].contextWindow, 8192);
});

test('invalid/empty catalogs and credential redirects fail closed', async t => {
  let payload = '{invalid';
  const baseUrl = await server(t, (req, res) => res.end(payload));
  const provider = createUniRouteProvider(sdk, { baseUrl });
  await assert.rejects(provider.catalog.run(catalogContext()), /invalid JSON/);
  payload = JSON.stringify({ data: [] });
  await assert.rejects(provider.catalog.run(catalogContext()), /no models/);
  let leaked = false;
  const redirected = await server(t, (req, res) => { leaked = true; res.end('{}'); });
  const redirector = await server(t, (req, res) => { res.writeHead(302, { location: redirected }); res.end(); });
  await assert.rejects(createUniRouteProvider(sdk, { baseUrl: redirector }).catalog.run(catalogContext()), /Cannot reach/);
  assert.equal(leaked, false);
});

test('timeout and host cancellation release discovery', async t => {
  const baseUrl = await server(t, () => {});
  await assert.rejects(createUniRouteProvider(sdk, { baseUrl, timeoutMs: 30 }).catalog.run(catalogContext()), /timed out/);
  const controller = new AbortController();
  const pending = createUniRouteProvider(sdk, { baseUrl }).catalog.run({ ...catalogContext(), signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, /timed out|abort/i);
});
