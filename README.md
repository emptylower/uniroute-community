# UniRoute community components

Community configuration components for the UniRoute gateway. These components configure official AI clients; they do not provide copies of those clients.

| Component                         | Purpose                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/uniroute-setup`         | Configuration CLI for Claude Code, Codex, Gemini CLI, OpenCode, OpenClaw and Hermes |
| `packages/openclaw-uniroute-auth` | OpenClaw native API-key authentication and API-key model discovery                  |
| `plugins/uniroute-setup`          | Claude Code plugin containing the UniRoute setup Skill                              |

## Use the configuration CLI

Node.js 22+ is required. The release is distributed as a versioned archive from the UniRoute website:

```sh
npx --yes --package=https://all-model-router.app/community/uniroute-setup-0.1.0.tgz uniroute-setup models
npx --yes --package=https://all-model-router.app/community/uniroute-setup-0.1.0.tgz uniroute-setup configure codex --model MODEL_ID --dry-run
npx --yes --package=https://all-model-router.app/community/uniroute-setup-0.1.0.tgz uniroute-setup configure codex --model MODEL_ID
```

Replace `MODEL_ID` with an ID returned by your API-key catalog. The CLI prompts for the API key without echoing it. Automation can use `UNIROUTE_API_KEY` or `--key-file /path/to/private-file`. Do not pass credentials as arguments or paste them into an AI conversation. Changed configuration files are backed up, and unrelated settings are retained. `--home /absolute/test-home` supports isolated configuration trials.

## Install the Claude Code Skill

In Claude Code:

```text
/plugin marketplace add emptylower/uniroute-community
/plugin install uniroute-setup@uniroute-marketplace
```

The marketplace contains the configuration Skill, which guides the agent through the same CLI. The canonical source is `.claude/skills/uniroute-setup`; the build generates its marketplace copy under `plugins/uniroute-setup/skills/uniroute-setup`. For Codex, install the [Skill ZIP](https://all-model-router.app/community/uniroute-setup-skill-0.1.0.zip) in `.agents/skills/uniroute-setup` and invoke `$uniroute-setup`.

## Install the OpenClaw plugin

The plugin is tested against OpenClaw `2026.9.8`. Follow that client's Node.js requirements: Node 24.16+ on 24.x, or 26.1+.

```sh
curl -fL https://all-model-router.app/community/openclaw-uniroute-auth-0.1.0.tgz -o openclaw-uniroute-auth-0.1.0.tgz
openclaw plugins install ./openclaw-uniroute-auth-0.1.0.tgz
openclaw models auth login --provider uniroute --method api-key
```

Authentication discovers only models visible to the supplied key and preserves the existing default. Choose the desired default explicitly after login. See the [OpenClaw guide](https://all-model-router.app/zh/docs/openclaw) for provider names and model selection.

## Develop and build

From the root of the standalone `uniroute-community` repository, install package dependencies and build before running the tests:

```sh
npm ci --ignore-scripts --prefix packages/uniroute-setup
npm ci --ignore-scripts --prefix packages/openclaw-uniroute-auth
npm run build
npm test
```

The build validates matching package versions, rebuilds the OpenClaw extension, generates the marketplace Skill, and writes release archives, a manifest, and SHA-256 checksums under `public/community/`. Build output is required by the OpenClaw tests. In the UniRoute website repository, use the package paths with the `community/` prefix:

```sh
npm ci --ignore-scripts --prefix community/packages/uniroute-setup
npm ci --ignore-scripts --prefix community/packages/openclaw-uniroute-auth
npm run community:build
npm run community:test
```

The build uses a temporary directory and an isolated temporary npm cache; it does not modify the user's client settings.

Configuration and catalog discovery do not automatically make a paid inference request. To verify actual use, send a request yourself and check UniRoute usage records.

## License and references

UniRoute component code is licensed under [MIT](LICENSE). Upstream material was inspected as a behavior reference; this repository contains independently authored implementation. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for reference links and dependency attribution.

Documentation: https://all-model-router.app/zh/docs/uniroute-skill
