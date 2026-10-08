# Third-party notices

## Behavior references

The following documentation and repositories were inspected to understand installation workflows and client integration contracts:

- AI Code With documentation: https://docs.aicodewith.ai/zh/docs
- Claude Code plugin marketplaces: https://code.claude.com/docs/en/plugin-marketplaces
- OpenClaw plugin and provider documentation: https://docs.openclaw.ai/
- OpenAI Codex configuration: https://developers.openai.com/codex/config-reference
- Gemini CLI: https://geminicli.com/docs/
- OpenCode providers: https://opencode.ai/docs/providers/
- Hermes Agent: https://hermes-agent.nousresearch.com/docs/

The community implementations and Skill are independently authored. No AI Code With plugin source or copied model catalog is included, and this project's MIT license does not relicense upstream references. Client names and trademarks belong to their respective owners.

## Package dependencies

The setup CLI uses `json5` (MIT), `jsonc-parser` (MIT), `smol-toml` (MIT), and `yaml` (ISC). These are installed as dependencies and retain their own license files. The OpenClaw extension build uses `esbuild` (MIT); its generated output retains dependency legal comments. OpenClaw is an external peer dependency, not redistributed in the plugin archive.

Consult each package's installed license and lockfile for the exact dependency version and complete terms.
