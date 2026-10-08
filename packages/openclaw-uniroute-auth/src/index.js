import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { createProviderApiKeyAuthMethod, buildApiKeyCredential } from 'openclaw/plugin-sdk/provider-auth';
import { captureProviderApiKey } from 'openclaw/plugin-sdk/provider-auth-api-key';
import { createUniRouteProvider } from './provider.js';

export default definePluginEntry({
  id: 'openclaw-uniroute-auth', name: 'UniRoute',
  description: 'UniRoute API-key authentication and live model catalog',
  register(api) {
    api.registerProvider(createUniRouteProvider({
      createProviderApiKeyAuthMethod, captureProviderApiKey, buildApiKeyCredential,
    }, api.pluginConfig ?? {}));
  },
});
