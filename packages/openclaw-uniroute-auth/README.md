# UniRoute OpenClaw provider

Independent implementation for **OpenClaw 2026.9.8**, Node.js **24.x from 24.16.0,
or 26.1.0 and later**. The host excludes Node.js 25.x and 26.0.x.
This package has no lifecycle/install scripts, telemetry, background updater or
configuration migration. The OpenClaw SDK is experimental; other host versions
are not yet verified. It delegates inference to OpenClaw's native transports.

## Install a release artifact

Until the package is published to npm, use the downloadable release tarball:

```sh
curl -fL https://all-model-router.app/community/openclaw-uniroute-auth-0.1.1.tgz -o openclaw-uniroute-auth-0.1.1.tgz
openclaw plugins install ./openclaw-uniroute-auth-0.1.1.tgz
openclaw models auth login --provider uniroute --method api-key
openclaw models list --all --provider uniroute-openai-responses --refresh
```

OpenClaw asks whether to install this non-ClawHub source, then whether to accept
the package's five UniRoute provider IDs. Review those prompts and confirm the
expected providers. The package declares no tools, channels, hooks or MCP servers.

Authentication prompts for a key and validates authenticated `GET /v1/models`
before returning credentials to the host. OpenClaw owns auth-profile persistence,
secret storage and JSON5 configuration. The plugin's single `uniroute` profile is
shared by its four provider variants through `providerAuthAliases`. Existing
default models and unrelated settings are preserved. Choose an actual listed ID:

```sh
openclaw models set uniroute-openai-responses/ACTUAL_MODEL_ID
```

You can use `UNIROUTE_API_KEY` for host-managed environment auth. Never put a real
API key in an install URL or a pasted command. With restrictive plugin allowlists,
explicitly permit `openclaw-uniroute-auth` in your existing `plugins.allow` list.

| Model family | Provider | Native API | Base URL |
| --- | --- | --- | --- |
| Claude | `uniroute-anthropic` | `anthropic-messages` | `https://api.all-model-router.app` |
| GPT / Codex / o-series | `uniroute-openai-responses` | `openai-responses` | `https://api.all-model-router.app/v1` |
| Supported chat families | `uniroute-openai-chat` | `openai-completions` | `https://api.all-model-router.app/v1` |
| Gemini | `uniroute-gemini` | `google-generative-ai` | `https://api.all-model-router.app/v1beta` |

Only IDs returned by the authenticated catalog are added. Unknown families are
skipped; a catalog containing no recognized models fails visibly. Network, HTTP
401/403/429, invalid JSON and empty catalogs fail without invented fallback models.
Errors do not include API keys or upstream response bodies.

## Explicit settings

Optional host configuration under `plugins.entries.openclaw-uniroute-auth.config`:

```json
{
  "baseUrl": "https://api.all-model-router.app",
  "timeoutMs": 15000,
  "modelProtocols": { "your-verified-custom-model": "openai-chat" }
}
```

The custom model must still appear in authenticated discovery. Confirm its
transport with the gateway before assigning a protocol. HTTPS is required except
for loopback test servers. URL credentials and redirects are rejected.

The gateway currently supplies IDs rather than trustworthy limits/prices. New
model records conservatively use text input, no declared reasoning, 8192 context
tokens and 2048 output tokens. These are fallback configuration limits, not claims
about model capability. OpenClaw requires numeric costs: zero means **unknown** in
these records, not free inference; UniRoute's billed prices remain authoritative.
Existing manually configured limits, costs, capabilities and provider headers
are retained. Refine these fields in `models.providers.<provider>.models` using
verified provider metadata. Registration never reads or rewrites a user's files.

## Development

```sh
npm ci --ignore-scripts
npm run build
npm test
npm pack --ignore-scripts
```

The build bundles the independently authored sibling setup package's catalog
helpers, so the release has no runtime dependency on that sibling. Tests run
against the actual installed OpenClaw SDK and mock HTTP, without a real account.
Research downloads and host test state belong in the removable `.research` tree.
For an existing isolated host installation, tests optionally accept
`UNIROUTE_OPENCLAW_SDK_ROOT=/path/to/openclaw/dist/plugin-sdk`; builds optionally
accept `UNIROUTE_ESBUILD_MODULE=/path/to/esbuild/lib/main.js`.

Protocol ideas were studied from AI Code With's public plugin and documentation;
no upstream source code was copied. See [OpenClaw's provider SDK guide](https://docs.openclaw.ai/plugins/sdk-provider-plugins).
