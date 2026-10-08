# UniRoute Setup

An original Node.js CLI for configuring AI clients against a UniRoute gateway.
It discovers model IDs from your **authenticated `GET /v1/models` catalog**.
Website marketplace records are not an operational model list. Catalog access
does not prove that an inference request, tool call or billing settlement works.

Requires Node.js 22+. This package is currently distributed as source/a local
tarball; npm publication is a separate release step. Do not assume that
`npx uniroute-setup` resolves to this code until the release is published.

## Run from the repository

```sh
cd community/packages/uniroute-setup
npm ci --ignore-scripts
node src/cli.js --help
```

Supply the key through the interactive **hidden** prompt, `UNIROUTE_API_KEY`, or a
private regular file using `--key-file /path/to/key` (`chmod 600`). API keys cannot
be passed in command-line arguments and are never printed. Existing secrets in
config files and backups remain secrets; the CLI writes them with mode `0600`.

```sh
# The terminal prompts for a key without echoing it.
node src/cli.js models

# Replace <catalog-id> with an exact ID returned by models.
# --home lets you review the result in a removable isolated directory.
node src/cli.js configure opencode --model '<catalog-id>' --home ./isolated-home --dry-run
node src/cli.js configure opencode --model '<catalog-id>' --home ./isolated-home
node src/cli.js doctor opencode --home ./isolated-home
```

When a real terminal is available, omitting `--model` shows compatible catalog
choices. In scripts, `--model` is required. Unknown model families require a
confirmed `--protocol anthropic|openai-responses|openai-chat|gemini`. A protocol
override is a user assertion about the selected gateway route, not a conversion
between APIs. Native Gemini is deliberately rejected by the Hermes adapter.

Optional flags: `--base-url https://gateway.example`, `--timeout-ms 15000`,
`--json`, `--dry-run`. Only HTTPS and loopback HTTP roots are accepted; redirects
are rejected. A pasted `/v1` suffix is normalized to the gateway root. Discovery
returns useful failures for HTTP 401/403/429, malformed catalogs and timeouts.
A 403 may indicate balance or permission problems; it is never treated as an
empty catalog or a reason to write invented models.

## Client configuration

| Client | Files under selected home | Protocol and gateway base |
| --- | --- | --- |
| Claude Code | `.claude/settings.json` | Anthropic: root via `ANTHROPIC_BASE_URL`, token via `ANTHROPIC_AUTH_TOKEN`; selected `model` |
| Codex | `.codex/config.toml`, `.codex/auth.json` | Responses: `/v1`, `wire_api=responses`, `requires_openai_auth=true`, file API-key auth |
| Gemini CLI | `.gemini/settings.json`, `.gemini/.env` | Native Gemini: root via `GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `gemini-api-key` auth |
| OpenCode | existing `.config/opencode/opencode.json` or `.jsonc` | Anthropic `/v1`, Responses/Chat `/v1`, Gemini `/v1beta`, native AI SDK provider |
| OpenClaw | `.openclaw/openclaw.json` | Anthropic root; Responses/Chat `/v1`; Gemini `/v1beta` |
| Hermes Agent | `.hermes/config.yaml`, `.hermes/.env` | Current `providers` map with `anthropic_messages`, `codex_responses`, or `chat_completions` transport |

OpenCode uses `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible`,
or `@ai-sdk/google` as appropriate. No community plugin or `oh-my-opencode`
installation is required. OpenCode loads its official provider packages itself.

Each configuration command selects the requested model as the client default.
Unrelated providers, models, plugins, permissions, fallback models and settings
are preserved. The CLI changes only the selected UniRoute provider and the
client's active connection/model settings. Other protocol groups are retained.
Claude's competing config-level `ANTHROPIC_API_KEY` is removed. Codex switches its
credential storage to `file` and replaces active OAuth tokens with `apikey` auth;
the original auth file remains in a protected backup. Hermes stores the key in
its `.env` and references it with `key_env: UNIROUTE_API_KEY`.

The CLI does not change shell environment variables. An existing shell,
project-level config, Codex profile, client-specific home override, or external
credential store may override user configuration. Restart the client with the
matching client home/environment and inspect its effective settings. `--home`
selects where this CLI writes files; it does not change another application's
runtime home automatically.

No context windows, token prices, vision support or reasoning support are
invented. Model entries contain IDs and names only; if a client needs explicit
limits, configure them from your route's verified capabilities.

## Preservation and verification

Existing files are parsed before any file is written; malformed input fails
closed. JSON/JSONC edits retain comments and unrelated text. YAML edits retain
comments. JSON5-specific syntax and TOML are reserialized while preserving
unrelated values; their original formatting/comments remain in the backup.
Ambiguous OpenCode `.json` plus `.jsonc` configs are rejected.

Writes use private, same-directory temporary files and atomic rename. Original
files get separate `0600` backups named `*.uniroute-<uuid>.bak`. If a later
file in the same command fails, already written files are restored. Setup
rejects symlink paths, hard-linked targets, invalid parent shapes and concurrent
file changes detected before commit. It is not a filesystem lock; avoid other
config writers during setup. Repeating an unchanged configuration creates no
new backup. `--dry-run` neither writes nor creates local directories.

```sh
npm run check
npm test
```

Tests use a mock authenticated HTTP gateway and disposable isolated homes. They
default to the operating system's temporary directory; set `UNIROUTE_TEST_ROOT`
to keep fixtures under a selected research directory. Each fixture is removed
after its test, and tests do not assume any parent repository layout. They
cover all six clients/four protocol mappings, preservation, JSONC/YAML comments,
key rotation, backups/permissions, idempotency, dry runs, protocol mismatches,
HTTP failures, invalid config/catalog, private key files and path boundaries.
These tests prove configuration behavior; they do not perform paid production
inference. `doctor [client]` is an offline check of local configuration and file
permissions. It never calls the gateway or prints credentials.

Host configuration checks also passed with installed Codex CLI `0.161.0`
(`features list`, isolated `CODEX_HOME`) and official npm `opencode-ai` `1.18.35`
(`serve`, authenticated `GET /config` and `GET /provider`, all four provider
groups loaded). The OpenCode check used a strict mock gateway allowing only
authenticated `GET /v1/models`; it made no inference calls. A separately
installed OpenCode `v2.0.21` returned its web app HTML at those documented server
routes, so compatibility with that v2 distribution is not established here.

## Shared catalog helper

The package root exports `fetchCatalog({baseUrl, apiKey, timeoutMs})`,
`selectModel(catalog, id, explicitProtocol)`, `inferProtocol(id)`,
`protocolDefinition(protocol, baseUrl)`, `groupCatalog(catalog, baseUrl)`,
`normalizeBaseUrl`, `validateApiKey`, `DEFAULT_BASE_URL` and `PROTOCOLS`.
Catalog entries are `{id, name, protocol}`; names accept gateway `name` or
`display_name`. Protocols are `anthropic`, `openai-responses`, `openai-chat`,
`gemini`, or `null` for unknown families. Definitions include OpenClaw API/base,
OpenCode npm/base and supported Hermes transport/base values. Discovery and
grouping never modify client configuration or defaults.

Official configuration references:

- [Claude Code settings](https://code.claude.com/docs/en/settings)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [Gemini CLI authentication](https://geminicli.com/docs/get-started/authentication/)
- [OpenCode providers](https://opencode.ai/docs/providers/)
- [OpenClaw model providers](https://docs.openclaw.ai/concepts/model-providers)
- [Hermes Agent providers](https://hermes-agent.nousresearch.com/docs/integrations/providers/)

License: MIT for this original UniRoute implementation. No upstream third-party
plugin source is included in this package.
