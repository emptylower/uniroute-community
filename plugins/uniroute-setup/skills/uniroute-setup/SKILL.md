---
name: uniroute-setup
description: Configure Claude Code, Codex, Gemini CLI, OpenCode, OpenClaw, or Hermes to use UniRoute, or discover the account's available model IDs. Use when the user asks to connect one of these clients to UniRoute.
---

# UniRoute setup

Use the UniRoute configuration CLI to query the model catalog visible to the current API key and update the selected client's configuration. Respect the user's chosen client and model. Official clients are separate prerequisites; install or update them only within the user's requested scope.

## Workflow

1. Check the client's existing configuration and Node.js version. The configuration CLI needs Node.js 22+. Use `--home /absolute/test-home` for an isolated trial; the default targets the current user's home directory. Do not replace unrelated settings or install unrelated plugins.
2. Have the user enter the Key in their own terminal's masked prompt, or use an already supplied `UNIROUTE_API_KEY` environment variable or private `--key-file` path. Never request a Key in chat, print it, place it in command-line arguments, or dump authentication files. If your tools cannot accept hidden user input and no credential source exists, give the user the command to run locally.
3. Query the catalog:

   ```sh
   npx --yes --package=https://all-model-router.app/community/uniroute-setup-0.1.0.tgz uniroute-setup models
   ```

   Use complete model IDs from this response. Catalog discovery is configuration input, not evidence that an inference call succeeded. Do not invent IDs, capabilities, prices, context limits, or availability. On authentication, permission, network, or catalog errors, report the error and resolve it before writing configuration. An unknown model family requires a confirmed protocol via `--protocol`.
4. Preview the requested change, then apply it within the user's existing authorization:

   ```sh
   npx --yes --package=https://all-model-router.app/community/uniroute-setup-0.1.0.tgz uniroute-setup configure CLIENT --model MODEL_ID --dry-run
   npx --yes --package=https://all-model-router.app/community/uniroute-setup-0.1.0.tgz uniroute-setup configure CLIENT --model MODEL_ID
   ```

   Replace `CLIENT` with `claude`, `codex`, `gemini`, `opencode`, `openclaw`, or `hermes`. The CLI backs up changed files, preserves unrelated configuration, and avoids rewriting identical configuration. Keep backup locations in the completion report. Use the same credential source and home directory for preview and application.
5. Verify the CLI result and the client's selected provider/model without printing credentials. Ask the user to reopen a running client when needed. Do not automatically send a paid model request or enable heartbeat, channels, cron jobs, or additional skills. If the user requests a real call, check its response and the UniRoute usage record.

## Protocols and endpoints

The default gateway root is `https://api.all-model-router.app`; catalog discovery uses `/v1/models`. Native protocol configuration is handled by the CLI:

- Claude Code: Anthropic Messages; gateway root.
- Codex: OpenAI Responses; root plus `/v1`.
- Gemini CLI: Gemini native API; `GOOGLE_GEMINI_BASE_URL` is the gateway root.
- OpenCode: Anthropic, OpenAI Responses, compatible Chat Completions, or Gemini via the corresponding AI SDK adapter.
- OpenClaw: corresponding native provider API, grouped by protocol.
- Hermes: Anthropic Messages, Responses, or Chat Completions. Do not point a Chat Completions provider at Gemini `/v1beta`.

For OpenClaw's optional native authentication plugin, follow https://all-model-router.app/zh/docs/openclaw rather than inventing an npm package or marketplace source. The Skill itself does not require that plugin.

Documentation: https://all-model-router.app/zh/docs/uniroute-skill
Source: https://github.com/emptylower/uniroute-community
