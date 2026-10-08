export const DEFAULT_BASE_URL = 'https://api.all-model-router.app';
export const PROTOCOLS = ['anthropic', 'openai-responses', 'openai-chat', 'gemini'];

export function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid gateway base URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Gateway base URL must use HTTPS (HTTP is allowed only on loopback).');
  }
  if (url.username || url.password || url.search || url.hash || /[\r\n]/.test(value)) {
    throw new Error('Gateway base URL cannot contain credentials, query parameters or fragments.');
  }
  // Accept a pasted /v1 URL, but keep one canonical root for native protocols.
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return url.toString().replace(/\/$/, '');
}

export function validateApiKey(apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\x00-\x20\x7f]/.test(apiKey)) {
    throw new Error('A nonempty API key without whitespace is required.');
  }
  return apiKey;
}

export function inferProtocol(id) {
  const name = id.toLowerCase().split('/').at(-1);
  if (/^claude(?:-|$)/.test(name)) return 'anthropic';
  if (/^(?:gpt(?:-|$)|o[1-9](?:-|$)|codex(?:-|$))/.test(name)) return 'openai-responses';
  if (/^gemini(?:-|$)/.test(name)) return 'gemini';
  if (/^(?:deepseek|qwen|glm|kimi|moonshot|grok|llama|mistral|mixtral|minimax)(?:[-_.]|$)/.test(name)) return 'openai-chat';
  return null;
}

export async function fetchCatalog({ baseUrl = DEFAULT_BASE_URL, apiKey, timeoutMs = 15_000, fetchImpl = fetch }) {
  const root = normalizeBaseUrl(baseUrl);
  validateApiKey(apiKey);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Timeout must be a positive number of milliseconds.');
  let response;
  let body;
  try {
    response = await fetchImpl(`${root}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    if (!response.ok) {
      const explanations = {
        401: 'Authentication failed; check your UniRoute API key.',
        403: 'Access denied; check key permissions, account balance and route availability. This is not an empty model catalog.',
        429: 'Rate limit reached; retry later.',
      };
      throw new Error(`Gateway HTTP ${response.status}: ${explanations[response.status] || 'Model discovery failed.'}`);
    }
    body = await response.text();
  } catch (error) {
    if (error.message.startsWith('Gateway HTTP ')) throw error;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('Gateway model discovery timed out.');
    throw new Error('Cannot reach the gateway model catalog. Check connectivity and the base URL.');
  }
  let payload;
  try { payload = JSON.parse(body); } catch { throw new Error('Gateway returned invalid JSON for the model catalog.'); }
  if (!payload || !Array.isArray(payload.data)) throw new Error('Gateway model catalog must contain a data array.');
  const seen = new Set();
  const catalog = payload.data.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || /[\x00-\x20\x7f]/.test(item.id) || ['__proto__', 'constructor', 'prototype'].includes(item.id) || item.id.includes(apiKey)) {
      throw new Error('Gateway returned an invalid model ID.');
    }
    if (seen.has(item.id)) throw new Error('Gateway returned duplicate model IDs.');
    seen.add(item.id);
    const displayName = typeof item.name === 'string' ? item.name : typeof item.display_name === 'string' ? item.display_name : item.id;
    return { id: item.id, name: displayName.replace(/[\x00-\x1f\x7f]/g, ' ').split(apiKey).join('[REDACTED]'), protocol: inferProtocol(item.id) };
  });
  if (!catalog.length) throw new Error('Your authenticated catalog contains no models. Check route availability.');
  return catalog;
}

export function selectModel(catalog, id, explicitProtocol) {
  const model = catalog.find(item => item.id === id);
  if (!model) throw new Error('Selected model is absent from your authenticated gateway catalog. Run models first.');
  if (explicitProtocol && !PROTOCOLS.includes(explicitProtocol)) throw new Error(`Protocol must be one of: ${PROTOCOLS.join(', ')}.`);
  const protocol = explicitProtocol || model.protocol || inferProtocol(id);
  if (!protocol) throw new Error('Unknown model family. Confirm the gateway protocol and supply --protocol explicitly.');
  return { ...model, protocol };
}

export function protocolDefinition(protocol, baseUrl = DEFAULT_BASE_URL) {
  const root = normalizeBaseUrl(baseUrl);
  const definitions = {
    anthropic: { openclawApi: 'anthropic-messages', openclawBaseUrl: root, opencodePackage: '@ai-sdk/anthropic', opencodeBaseUrl: `${root}/v1`, hermesTransport: 'anthropic_messages', hermesBaseUrl: root },
    'openai-responses': { openclawApi: 'openai-responses', openclawBaseUrl: `${root}/v1`, opencodePackage: '@ai-sdk/openai', opencodeBaseUrl: `${root}/v1`, hermesTransport: 'codex_responses', hermesBaseUrl: `${root}/v1` },
    'openai-chat': { openclawApi: 'openai-completions', openclawBaseUrl: `${root}/v1`, opencodePackage: '@ai-sdk/openai-compatible', opencodeBaseUrl: `${root}/v1`, hermesTransport: 'chat_completions', hermesBaseUrl: `${root}/v1` },
    gemini: { openclawApi: 'google-generative-ai', openclawBaseUrl: `${root}/v1beta`, opencodePackage: '@ai-sdk/google', opencodeBaseUrl: `${root}/v1beta` },
  };
  if (!definitions[protocol]) throw new Error('Unsupported protocol.');
  return definitions[protocol];
}

export function groupCatalog(catalog, baseUrl = DEFAULT_BASE_URL) {
  return PROTOCOLS.map(protocol => ({
    id: `uniroute-${protocol}`, protocol, ...protocolDefinition(protocol, baseUrl),
    models: catalog.filter(model => model.protocol === protocol),
  })).filter(group => group.models.length);
}
