import {
  DEFAULT_BASE_URL, PROTOCOLS, fetchCatalog, normalizeBaseUrl, protocolDefinition, selectModel,
} from '../../uniroute-setup/src/catalog.js';

export const PROVIDER_IDS = PROTOCOLS.map(protocol => `uniroute-${protocol}`);

export function createUniRouteProvider(sdk, options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const authOptions = {
    providerId: 'uniroute', methodId: 'api-key', label: 'UniRoute API key',
    hint: 'Validates access to your live UniRoute model catalog',
    optionKey: 'unirouteApiKey', flagName: '--uniroute-api-key', envVar: 'UNIROUTE_API_KEY',
    promptMessage: 'Enter your UniRoute API key', preserveExistingPrimary: true,
  };
  const hostAuth = sdk.createProviderApiKeyAuthMethod(authOptions);

  async function discover(apiKey, signal) {
    signal?.throwIfAborted();
    const catalog = await fetchCatalog({
      baseUrl, apiKey, timeoutMs,
      fetchImpl: (url, init) => (options.fetchImpl ?? fetch)(url, {
        ...init, ...(signal ? { signal: AbortSignal.any([signal, init.signal]) } : {}),
      }),
    });
    signal?.throwIfAborted();
    const supported = catalog.flatMap(model => {
      const explicitProtocol = options.modelProtocols?.[model.id];
      if (!model.protocol && !explicitProtocol) return [];
      return [selectModel(catalog, model.id, explicitProtocol)];
    });
    if (!supported.length) throw new Error('Your UniRoute catalog contains no recognized text models. Configure modelProtocols for a verified custom model.');
    return supported;
  }

  function providerConfigs(models, config, apiKey) {
    const providers = {};
    for (const protocol of PROTOCOLS) {
      const id = `uniroute-${protocol}`;
      const matching = models.filter(model => model.protocol === protocol);
      if (!matching.length) continue;
      const existing = config?.models?.providers?.[id] ?? {};
      const mergedModels = new Map((existing.models ?? []).map(model => [model.id, model]));
      for (const model of matching) {
        mergedModels.set(model.id, {
          id: model.id, name: model.name, reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192, maxTokens: 2048,
          ...mergedModels.get(model.id),
        });
      }
      const definition = protocolDefinition(protocol, baseUrl);
      providers[id] = {
        ...existing, baseUrl: definition.openclawBaseUrl, api: definition.openclawApi,
        ...(apiKey === undefined ? {} : { apiKey }), models: [...mergedModels.values()],
      };
    }
    return providers;
  }

  const auth = {
    ...hostAuth,
    async run(ctx) {
      ctx.assertCurrent?.();
      const flagValue = ctx.opts?.unirouteApiKey;
      const { apiKey, input, mode } = await sdk.captureProviderApiKey(ctx, {
        token: flagValue ?? ctx.opts?.token,
        tokenProvider: flagValue ? 'uniroute' : ctx.opts?.tokenProvider,
        env: ctx.env, expectedProviders: ['uniroute'], provider: 'uniroute',
        envLabel: 'UNIROUTE_API_KEY', promptMessage: authOptions.promptMessage,
      });
      const models = await discover(apiKey, ctx.signal);
      ctx.assertCurrent?.();
      return {
        profiles: [{
          profileId: 'uniroute:default',
          credential: sdk.buildApiKeyCredential('uniroute', input, undefined, { secretInputMode: mode, config: ctx.config }),
        }],
        configPatch: {
          auth: { profiles: { 'uniroute:default': { provider: 'uniroute', mode: 'api_key' } } },
          models: { providers: providerConfigs(models, ctx.config) },
        },
        notes: ['UniRoute API key validated. Select a discovered model explicitly; the current default is preserved.'],
      };
    },
    async runNonInteractive(ctx) {
      const resolved = await ctx.resolveApiKey({
        provider: 'uniroute', flagValue: ctx.opts?.unirouteApiKey,
        flagName: '--uniroute-api-key', envVar: 'UNIROUTE_API_KEY',
      });
      if (!resolved) return null;
      const models = await discover(resolved.key);
      const next = await hostAuth.runNonInteractive({ ...ctx, resolveApiKey: async () => resolved });
      if (!next) return next;
      return {
        ...next, models: {
          ...next.models,
          providers: { ...next.models?.providers, ...providerConfigs(models, next) },
        },
      };
    },
  };

  return {
    id: 'uniroute', label: 'UniRoute', hookAliases: PROVIDER_IDS,
    docsPath: 'https://all-model-router.app/zh/docs/openclaw', envVars: ['UNIROUTE_API_KEY'], auth: [auth],
    catalog: {
      order: 'paired',
      async run(ctx) {
        const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey('uniroute');
        if (!apiKey) return null;
        const models = await discover(discoveryApiKey ?? apiKey, ctx.signal);
        return { providers: providerConfigs(models, ctx.config, apiKey) };
      },
    },
  };
}
