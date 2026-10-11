# Host steps after `npx -y @getmarrow/install@0.1.68`

The installer writes only for hosts it detects in the project (or, for Grok and Claude Code, in the home directory). It reconciles only Marrow's own entries and keeps the owner's other hooks and settings. Hooks are cooperative and client-reported until the host has restarted and the owner has finished its review; a configured hook never proves coverage.

| Host | Detected from | Written to | After install |
| --- | --- | --- | --- |
| Codex | a `.codex` directory, or an `AGENTS.md` with the owner's own content | `.codex/hooks.json`, MCP config, the Marrow block in `AGENTS.md` | Restart Codex, then review and trust the hooks in `/hooks` |
| Cursor, Composer | a `.cursor` directory | `.cursor/hooks.json`, `.cursor/mcp.json` | Restart Cursor, then review the hooks in `/hooks` |
| Gemini CLI | a `.gemini` directory | `.gemini/settings.json` | Restart, then review and approve the project fingerprint in `/hooks panel` |
| Windsurf | a `.windsurf` directory | `.windsurf/hooks.json` | Restart, review workspace trust, and leave Restricted Mode |
| Cline | a `.clinerules` directory | `.clinerules/hooks/` | Turn on Enable Hooks, trust the executables and the workspace, then restart |
| Grok | `~/.grok` or `.grok` | `~/.grok/hooks/marrow.json` | Restart, then inspect `/hooks`; Grok hooks stay user-toggleable |
| Claude Code | `.claude/settings.json` or `CLAUDE.md` in the project, or Claude Code installed for the user | `.claude/settings.json`, `.mcp.json` | Prefer the plugin (`/plugin install marrow@getmarrow`). Do not use both in one project |

Other agents (OpenCode, DeepSeek, Qwen, Kimi, MiniMax, GLM and custom hosts) are not detected. Govern their consequential commands with the wrapper, `npx -y @getmarrow/install@0.1.68 run -- -- <command>`, labelled with `MARROW_CLIENT`; a custom host needs a bounded event adapter.

After the restart and review, verify once: `npx -y @getmarrow/install@0.1.68 doctor --self-test`.
