# Host steps after `npx -y @getmarrow/install@latest activate`

The installer writes only for hosts it detects in the project (or, for Grok and Claude Code, in the home directory). It reconciles only Marrow's own entries and keeps the owner's other hooks and settings. Hooks are cooperative and client-reported until the host has restarted and the owner has finished its review; a configured hook never proves coverage.

| Host | Detected from | Written to | After install |
| --- | --- | --- | --- |
| Codex | a `.codex` directory, or an `AGENTS.md` with the owner's own content | `.codex/hooks.json`, MCP config, the Marrow block in `AGENTS.md` | Installer 0.1.70 and earlier write tool hooks with a matcher Codex rejects, so with those versions they hold nothing; use the Marrow Codex plugin instead: `codex plugin marketplace add getmarrow/plugins`, then `codex plugin add marrow@getmarrow` (or `marrow-advisory@getmarrow`, no hooks; install one, not both). From 0.1.71 the installer's tool hooks use the matcher `*`, every tool call reaches Marrow's check, and `@getmarrow/mcp` 3.9.103 skips Marrow's own tools only for the official `marrow` server that the host's configuration proves. Restart Codex, then review and trust the hooks in `/hooks`. Do not use both the plugin and the installer in one project. The Codex plugins pin `@getmarrow/mcp` 3.9.102 and do not include the keyless seatbelt; it comes to them with the next update |
| Cursor, Composer | a `.cursor` directory | `.cursor/hooks.json`, `.cursor/mcp.json` | Prefer the Marrow plugin for Cursor: it includes the free keyless seatbelt (no account, no key). Otherwise restart Cursor, then review the hooks in `/hooks`. Do not use both in one project |
| Gemini CLI | a `.gemini` directory | `.gemini/settings.json` | Restart, then review and approve the project fingerprint in `/hooks panel` |
| Windsurf | a `.windsurf` directory | `.windsurf/hooks.json` | Restart, review workspace trust, and leave Restricted Mode |
| Cline | a `.clinerules` directory | `.clinerules/hooks/` | Turn on Enable Hooks, trust the executables and the workspace, then restart |
| Grok | `~/.grok` or `.grok` | `~/.grok/hooks/marrow.json` | Restart, then inspect `/hooks`; Grok hooks stay user-toggleable |
| Claude Code | `.claude/settings.json` or `CLAUDE.md` in the project, or Claude Code installed for the user | `.claude/settings.json`, `.mcp.json` | Prefer the plugin (`/plugin install marrow@getmarrow`): it includes the free keyless seatbelt (no account, no key). Do not use both in one project |

Codex: use the plugin, or the installer from 0.1.71 on, for protection. To remove the plugin: `codex plugin remove marrow@getmarrow` (or `marrow-advisory@getmarrow`), then `rm -rf ~/.codex/plugins/data/marrow-getmarrow`.

Other agents (OpenCode, DeepSeek, Qwen, Kimi, MiniMax, GLM and custom hosts) are not detected. Govern their consequential commands with the wrapper, `npx -y @getmarrow/install@0.1.70 run -- -- <command>`, labelled with `MARROW_CLIENT`; a custom host needs a bounded event adapter.

After the restart and review, verify once: `npx -y @getmarrow/install@latest doctor`.
