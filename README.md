# Marrow plugins for Claude Code, Codex and Cursor

The `getmarrow` marketplace for Claude Code, Cursor and Codex. Each host's `marrow` plugin adds Marrow's approval hooks, the Marrow MCP server and a short skill to that host. Codex also has `marrow-advisory`, with no hooks. For Cursor, see "Install in Cursor" below.

| Host | Plugin folder | Marketplace file |
| --- | --- | --- |
| Claude Code | `plugins/marrow` | `.claude-plugin/marketplace.json` |
| Cursor | `plugins/marrow-cursor` | `.cursor-plugin/marketplace.json` |
| Codex | `codex/marrow` (hooks), `codex/marrow-advisory` (no hooks; install one of the two, not both) | `.agents/plugins/marketplace.json` |

Each plugin governs its own host only. The Claude Code plugin does not govern Cursor, even where Cursor imports Claude Code plugins: Cursor users install the Cursor plugin (see "Install in Cursor" below).

The Claude Code and Cursor plugins run `@getmarrow/mcp` 3.9.106, which includes the free keyless seatbelt: with no account and no key, their hooks stop seven kinds of action (see "Without a key: the keyless seatbelt" below). With an account, Marrow holds risky actions for approval and keeps the audit trail. The Codex plugins pin `@getmarrow/mcp` 3.9.102 and do not include the keyless seatbelt; it comes to them with the next update.

**Windows:** Native Windows is not supported yet. Use WSL.

## Install in Claude Code

In Claude Code:

```text
/plugin marketplace add getmarrow/plugins
/plugin install marrow@getmarrow
```

Or from your shell, in one command (Claude Code v2.1.292 or later):

```bash
claude plugin install marrow --marketplace getmarrow/plugins
```

No account or key is needed to install. Claude Code shows what the plugin adds before you confirm. If it asks, run `/reload-plugins`. The hooks and MCP server need Node.js 18 or later on `PATH`, as Marrow's `npx` hooks do today.

Check that `claude plugin marketplace list` shows `getmarrow` coming from `getmarrow/plugins`, and that `claude plugin list` shows exactly one `marrow@...` plugin.

## Install in Cursor

Install from the plugin source or a local folder. <!-- LIVE-PROOF: replace this sentence with "Works on macOS and Linux." once live rows L1-L8 have passed --> <!-- WINDOWS-STATUS: set with the MCP 3.9.106 pin commit -->
It needs Node.js 18 or later with npm on `PATH`. No account or key is needed to install.

<!-- CURSOR-MARKETPLACE: listing pending Cursor review; Cliff adds the marketplace sentence once listed -->

1. In Cursor, add `https://github.com/getmarrow/plugins` as a plugin source, then install `marrow` and restart Cursor. Cursor reads this repository's `main` branch, a read-only branch that mirrors `master`.
2. Fallback, or to try a candidate: clone `getmarrow/plugins`, copy `plugins/marrow-cursor` to `~/.cursor/plugins/local/marrow`, and restart Cursor. Local plugins update only when you copy a newer folder over, and Cursor Enterprise may turn local plugins off.

With no Marrow key, the Marrow MCP server shows as connected with 0 tools, and the plugin's hooks still apply: see "Without a key: the keyless seatbelt" below, which also shows how to connect an account.

Only the MCP server, without hooks, is a one-click link (a page renders it as a link or an "Add to Cursor" button):

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=marrow&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIi0tcGFja2FnZT1AZ2V0bWFycm93L21jcEAzLjkuMTA2IiwibWFycm93LW1jcCJdfQ==
```

The `config` value is base64 of `{"command":"npx","args":["-y","--package=@getmarrow/mcp@3.9.106","marrow-mcp"]}`, pinned, with no key and no `env`. The MCP server alone is advisory: approvals are enforced only by the plugin's hooks. Unlike the plugin, the link starts the server through `npx`, which can pick up a copy of `@getmarrow/mcp` that a project's `node_modules` claims at the same version. Prefer the plugin.

## What each plugin adds

| Component | Claude Code (`plugins/marrow`) | Cursor (`plugins/marrow-cursor`) |
| --- | --- | --- |
| Hooks | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, and the async `PermissionRequest` and `PostToolBatch` hooks: the events `npx @getmarrow/install` writes into `.claude/settings.json`. Their tool matcher sends Marrow every tool call, built-in, MCP or future (`Monitor`, `PowerShell`, `WebFetch` and `Agent` included), and skips only this plugin's own 17 Marrow tools and the read-only `LS` and `ListMcpResourcesTool`, each by exact name. A warn-only `SessionStart` check says when Marrow is also set up outside the plugin or another plugin named `marrow` is enabled, and, while no key is set, that the keyless seatbelt is on. | The ten hooks `npx @getmarrow/install` 0.1.70 writes into `.cursor/hooks.json`: `preToolUse`, `beforeShellExecution` and `beforeMCPExecution` (15 s, `failClosed`), `postToolUse`, `postToolUseFailure`, `afterShellExecution`, `afterMCPExecution`, `stop`, `sessionStart` and `beforeSubmitPrompt`, with the installer's matchers byte for byte. |
| MCP server | `.mcp.json`: server `marrow`. Its tools are on demand. | `mcp.json`: server `marrow`. Its tools are on demand. |
| Skill | `skills/marrow`: when to call Marrow, holds and approvals, the key step, update commands. | `skills/marrow`: the same rules for Cursor. |

Both run the pinned `@getmarrow/mcp` 3.9.106 entrypoints, the same ones the installer writes, through the same launcher. The plugins add no policy of their own.

Hooks are cooperative, client-reported control. They act only while the plugin is enabled and the host runs them. A configured hook never proves coverage or enforcement on its own.

**Hook commands.** Every hook command is one string that names the plugin root variable and the entrypoint inline (`node "${CLAUDE_PLUGIN_ROOT}/scripts/marrow-launch.cjs" claude-pre-action-hook`, `node "${CURSOR_PLUGIN_ROOT}/scripts/marrow-launch.cjs" cursor-pre-action-hook`, `${PLUGIN_ROOT}` on Codex). None is relative to your project and none relies on separate `args`, which a host that imports the plugin may drop. The launcher starts the MCP server only for the explicit `mcp` argument in the plugin's MCP config; started with no argument it refuses (exit 2) and starts nothing. `tools/check.cjs` enforces both.

**Cursor: how Marrow's own tools are told apart.** Cursor's `preToolUse` names an MCP tool `MCP:<tool>`, with no server, so a name cannot prove which server it came from. The plugin uses `@getmarrow/install` 0.1.70's matchers byte for byte: every label that holds `MCP:` reaches the hook, `MCP:marrow_<anything>` included, and no MCP label is skipped by name. The pinned hook then allows Marrow's own tools only for the server exactly `marrow` and an exact registered tool name; `Marrow`, `MARROW`, padded and re-cased names go the normal path. `beforeMCPExecution` carries the server name and has no matcher. The plugin sends every MCP call there, Marrow's own included, to the pinned hook, with no fast-allow guard, so it never allows more than the installer's guard does.

## Without a key: the keyless seatbelt

When a pre-action hook has no usable Marrow key and the machine shows no sign of a Marrow account (for example an owner key file, a claim marker or Marrow's local approval state), the hook runs a local seatbelt instead of holding every protected action. It comes with `@getmarrow/mcp` 3.9.103 and later, which the Claude Code and Cursor plugins run. It needs no account and no key, and it makes no network call.

- **It stops seven kinds of action:** a change to Marrow's hooks, settings or plugins, or an owner-only Marrow command (S0); a force-push or delete of a protected branch (S1); a production deploy (S2); a package publish (S3); reading credentials or secrets, including a project `.env` file other than a template (S4); a recursive delete outside the workspace (S5); and decoded data run by a shell or interpreter (S-x). The stop is the host's own deny, with text that tells the agent to leave the action to the machine owner. It reads shell commands, each host's own file tools and MCP calls. It fails closed: an internal error, a check that runs past 300 ms, or input the host cut short stops the action.
- **Everything else gets no Marrow decision, so the host's own approval step decides:** Claude Code gets an empty answer. Cursor asks with its own approval prompt before a shell command that a hook without a key used to hold (for example `git commit` or `git push`); Cursor's other tools (MCP calls included) keep holding what a hook without a key held before. A tool the seatbelt does not recognise, or MCP arguments it cannot read, never gets the seatbelt's pass: the hook gives the answer a hook without a key gave before, a hold where that held.
- **Local receipts:** each seatbelt decision is written to `~/.marrow/seatbelt/receipts/` on this machine, as codes and keyed hashes, plus the built-in tool name and shell program names from fixed lists (any MCP tool is recorded only as `mcp`); no command text, argument, path or URL. They are kept for up to 90 days or 50 MB. Nothing is uploaded.
- **Folder permissions:** the seatbelt runs only where your home folder and the agent settings folders (such as `~/.claude`) can be written by you alone. On Linux, a folder that your own private group can also write (the default with umask 002) still counts. Any other folder keeps every hold, and the hold says that Marrow's keyless mode is off here.
- **It is a seatbelt, not a vault:** it runs on the machine as your user and makes no network call. A determined agent can get around a local check, for example with a script it writes now and runs later, an interpreter, or a tool path with no hook.
- **With an account:** Marrow holds risky actions for approval and keeps the audit trail. A machine linked to an account but with no working key keeps every hold it had, and the seatbelt stops apply too. With a working key the answers and requests are unchanged; the seatbelt only watches and records would-stops locally.

The Codex plugins pin `@getmarrow/mcp` 3.9.102 and do not include the keyless seatbelt; without a key their hooks hold protected actions with "Marrow has no API key" (see "Codex" below), and the seatbelt comes to them with the next update. The Marrow MCP server's tools need a key: in the Claude Code and Cursor plugins the server starts with no tools until one exists, and the Codex plugins' server does not start without one.

To connect an account, create an agent key at https://getmarrow.ai, then keep it in a file in your own terminal:

```bash
mkdir -p ~/.marrow && chmod 700 ~/.marrow
# put MARROW_API_KEY=<your_key> in ~/.marrow/env
chmod 600 ~/.marrow/env
```

Or set `MARROW_API_KEY` in the environment that starts the host. Then run `/reload-plugins` in Claude Code, or restart Cursor. Never paste a key into chat.

The plugins carry the hooks, so the hold message's "run the installer activate command" step is not needed for Claude Code or Cursor in a project that uses the plugin. That command (`MARROW_API_KEY=<your_key> npx -y @getmarrow/install@latest activate`), like the installer's `--repair`, writes a second copy of the hooks there. To check the key and connection, run `npx -y @getmarrow/install@latest doctor`. It only reads. Installer 0.1.71 and later count the Claude Code plugin's hooks; 0.1.70 and earlier report Claude Code hooks as missing, because the plugin holds them. The Cursor plugin is not counted, so doctor can report Cursor hooks as missing while the plugin holds them.

## Pinned versions and updates

- `package.json` and `package-lock.json` (the same files in both the Claude Code and the Cursor plugin) pin `@getmarrow/mcp` 3.9.106 and `@getmarrow/sdk` 3.7.67 with sha512 integrity, equal to `@getmarrow/install` 0.1.74's `src/pins.js`. The Codex plugins pin `@getmarrow/mcp` 3.9.102 and `@getmarrow/sdk` 3.7.65, equal to `@getmarrow/install` 0.1.70's `src/pins.js`.
- Hooks start the package with `node`, not `npx`. Each start checks every file against `scripts/mcp-manifest.json`. Claude Code installs the lockfile into the plugin's cached copy with install scripts disabled. If that copy is missing or changed, or on Cursor, which installs no plugin dependencies, the launcher installs the same lockfile once (`npm ci --ignore-scripts`, outside your project) and checks that copy the same way. Only the plugin's Marrow server (`mcp`), the context hook (your first prompt) and `prepare` install; no tool hook does. Claude Code keeps it in the plugin's data folder (`~/.claude/plugins/data/`, removed on uninstall), Cursor in `~/.marrow/cursor-plugin` (mode 700), Codex in `~/.codex/plugins/data/marrow-getmarrow/`. Nothing is fetched by version at run time and nothing runs from your project's `node_modules`.
- If no verified copy can be loaded (for example, offline on first use), the pre-action hook holds tool calls with a "Marrow plugin:" message until one can, and the other hooks report a non-blocking error. The pre-action hook never installs and never waits for another start's install: with no verified copy it answers at once (under a second), so the host's hook timeout (20 s on the Claude Code `PreToolUse` entry, above the 14 s the pinned hook allows itself) is never the thing that decides. On a fresh install the first tool call can be held for the second or so that the Marrow server's first start (or the first prompt) needs to install the copy; measured here, a cold start took about 1.3 s to a verified copy.
- Each plugin sets `version`, so the host keeps you on the installed copy until a new version is published and you update. Third-party Claude Code marketplaces do not auto-update unless you turn that on.
- To update the Claude Code plugin after Marrow reports a client update:

```bash
claude plugin marketplace update getmarrow
claude plugin update marrow@getmarrow
```

Cursor cannot install Marrow yet, so there is nothing to update there.

## Uninstall

```bash
claude plugin uninstall marrow@getmarrow
claude plugin marketplace remove getmarrow
```

Cursor cannot install Marrow yet; if you have a package copy from an earlier try, remove it with `rm -rf ~/.marrow/cursor-plugin`. In Codex, see "Update and remove" below.

The hooks and the MCP server live inside the plugin, so they go with it. What is left, exactly:

- **Claude Code.** Installing writes `enabledPlugins` (and, from the marketplace add, `extraKnownMarketplaces`) in `~/.claude/settings.json`; it writes no hook entries and does not touch your other settings. Uninstall removes the `enabledPlugins` entry and the plugin's data folder (`~/.claude/plugins/data/`). The cached plugin copy stays, marked `.orphaned_at`, until Claude Code's own cleanup removes it. `claude plugin marketplace remove getmarrow` removes the marketplace registration.
- **All hosts.** Marrow's runtime state under `~/.marrow` stays: for example `session-loop-guard/state.json`, and the cache, spool, health and host-approval files that build up in use. Your key file `~/.marrow/env` stays too. Delete the files you no longer want; nothing is deleted for you.

## Codex

The same repository is a Codex marketplace (`.agents/plugins/marketplace.json`) with two plugins:

| Plugin | What it adds |
| --- | --- |
| `marrow` | Marrow's Codex hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SessionEnd`), the Marrow MCP server and the skill. The hooks run the pinned `@getmarrow/mcp` 3.9.102 Codex entrypoints, the ones `npx @getmarrow/install` writes into `.codex/hooks.json`. Their tool matcher is `*`: every tool call reaches the hook, this plugin's own Marrow tools included, and the plugin exempts no tool by name. The pinned 3.9.102 hook then skips a call without a check when its label is exactly `mcp__marrow__<name>` for one of the 58 tool names the `marrow` server registers. It reads the label only and cannot tell which server produced it. |
| `marrow-advisory` | Advisory only: the Marrow MCP server and the skill, with no hooks. Nothing is held; Marrow sees an action only when the agent calls a `marrow_*` tool. |

Install one of them, not both: both name their MCP server `marrow`. Codex accepts both without a warning, and one server `marrow` then wins.

```bash
codex plugin marketplace add getmarrow/plugins
codex plugin add marrow@getmarrow
```

No account or key is needed to install. Start a new Codex session, then open `/hooks` and review and trust the Marrow hooks: Codex does not run plugin hooks until you trust them, and asks again whenever they change. On the first session start the plugin installs its pinned copy of `@getmarrow/mcp` (from `package-lock.json`, install scripts off) into `~/.codex/plugins/data/marrow-getmarrow/` and checks it against `scripts/mcp-manifest.json`; until a verified copy loads, `PreToolUse` holds tool calls with a "Marrow plugin:" message. Node.js 18 or later must be on `PATH`.

Key: without one, routine tool calls run and protected actions are held with "Marrow has no API key". These plugins pin `@getmarrow/mcp` 3.9.102, which has no keyless seatbelt; it comes to them with the next update. Codex passes a plugin MCP server only `MARROW_API_KEY` from your environment (by name; no key is stored in any config), so the simplest setup is the key file:

    mkdir -p ~/.marrow && chmod 700 ~/.marrow
    # put MARROW_API_KEY=<your_key> in ~/.marrow/env
    chmod 600 ~/.marrow/env

Update and remove:

```bash
codex plugin marketplace upgrade getmarrow
codex plugin remove marrow@getmarrow      # or marrow-advisory@getmarrow
rm -rf ~/.codex/plugins/data/marrow-getmarrow
```

`codex plugin remove` leaves the package copy in `~/.codex/plugins/data/marrow-getmarrow` (about 3 MB); the `rm` step deletes it. The runtime state under `~/.marrow` and your key file stay, as above.

`npx @getmarrow/install` writes Codex hooks too, and what they do depends on its version:

- **0.1.70 and earlier.** Their tool-hook matcher uses a lookahead that Codex rejects (`invalid matcher`), so their `PreToolUse` and `PostToolUse` hooks never load and no Codex tool call is checked. Only their context and session hooks run. For protection in Codex, use this plugin.
- **0.1.71 and later.** The installer writes the matcher `*`, so its Codex hooks send every tool call to Marrow's check, Marrow's own tools included. The check itself is `@getmarrow/mcp`: from 3.9.103 it skips Marrow's own tools only when the host's own configuration proves that the `marrow` server is the official Marrow MCP server (the `npx -y @getmarrow/mcp` entry with no project or environment npm setting that could change where npx fetches it, the installed `marrow-mcp`, the installer's verified runtime, or this plugin, verified file by file and installed alone, with no other server that could give the same label). A look-alike server or plugin, or one Marrow cannot prove, is checked like any other tool. Installers 0.1.71 and 0.1.72 pin 3.9.103; 0.1.73 pins 3.9.105.
- **This plugin's own hooks** run the `@getmarrow/mcp` 3.9.102 it pins. They get every tool call (`*`), and 3.9.102 skips by label alone (see the table above). They do not include the keyless seatbelt; it comes to them with the next update. A plugin release cannot pin an MCP that already carries that release's pins, so a Codex plugin pins an MCP older than the one that carries its pins ([docs/PLUGIN-RELEASE.md](docs/PLUGIN-RELEASE.md)).

Use the plugin or the installer for Codex, not both. If the installer's `.codex/hooks.json` is also there, its context and session hooks run twice next to the plugin's, and from installer 0.1.71 its tool hooks run next to the plugin's as well, so every tool call is checked by two separate hooks; keep one copy. Hooks are cooperative, client-reported control.

The bundled skill (`skills/marrow/SKILL.md` and `references/hosts.md` in both packages) is the `getmarrow/skills` copy byte for byte. Copy it from the skills repo when that changes; `--skills <checkout>` below fails if either package differs.

Maintainers: `node tools/codex-check.cjs <marrow-install>/src/pins.js <marrow-mcp>/src/cli.ts <marrow-install>/src/installer.js --skills <getmarrow/skills checkout> --rust <wasm>` checks both packages and the matcher's name table. Build the Rust checker once with `cargo build --release --target wasm32-wasip1` in `tools/codex-rust-matcher` (it compiles the matcher with the `regex` crate, the engine Codex uses). Change pins with `node tools/codex-pin-manifest.cjs <dir>` (same steps as above, for `codex/marrow`, then copy `package.json` and the lockfile into `codex/marrow-advisory`), and keep `OWN_TOOLS` in `tools/codex-matcher.cjs` equal to the default tool set. The tool matcher is the wildcard `*`, so no matcher is generated and no tool name belongs in `hooks/hooks.json`; `tools/codex-check.cjs` fails if one does.

## Using Marrow with other agents

Gemini CLI, Windsurf and other hosts get Marrow from the installer, run by the owner in a terminal: `MARROW_API_KEY=<your_key> npx -y @getmarrow/install@latest activate`, then `npx -y @getmarrow/install@latest doctor`. The skills for those agents are at https://github.com/getmarrow/skills.

## Maintainers: changing the pins

The Codex plugins are also pinned by `@getmarrow/mcp`: read [docs/PLUGIN-RELEASE.md](docs/PLUGIN-RELEASE.md) for the order before you change any of their six pinned files or bump their version. CI (`.github/workflows/codex-plugin-pins.yml`) fails on a pinned file that has no matching pin.

1. Set the new exact versions in `plugins/marrow/package.json`, then `npm install --package-lock-only --ignore-scripts` there.
2. In an empty directory with copies of `package.json` and `package-lock.json`: `npm ci --ignore-scripts`.
3. `node tools/pin-manifest.cjs <that directory>`.
4. Copy `package.json`, `package-lock.json`, `scripts/marrow-launch.cjs` and `scripts/mcp-manifest.json` to `plugins/marrow-cursor` (`tools/check.cjs` requires identical bytes).
5. Raise `version` in `plugins/marrow/.claude-plugin/plugin.json` and `plugins/marrow-cursor/.cursor-plugin/plugin.json`. A host keeps a cached copy while the version is unchanged, so a pin change without a version change never reaches users.
6. If the new MCP release changes its default tool set, update `OWN_TOOLS` in `tools/check.cjs` and the matcher in `plugins/marrow/hooks/hooks.json`. If the installer changes its Cursor hooks, update `plugins/marrow-cursor/hooks/hooks.json` and `CURSOR_EXPECTED`.
7. Run the checks:
   - `node tools/check.cjs <marrow-install>/src/pins.js <marrow-mcp>/src/cli.ts <marrow-mcp>/dist/hook-contract.js [<candidate marrow-mcp>/dist/hook-contract.js ...] [--installer-cursor-hooks <hooks.json the installer writes for Cursor>]` (use `src/tool-catalog.ts` for 3.9.102 and later in place of `src/cli.ts`)
   - `node tools/codex-check.cjs <marrow-install>/src/pins.js <marrow-mcp>/src/cli.ts <marrow-install>/src/installer.js --skills <getmarrow/skills checkout>`
   - `node tools/test-launcher.cjs claude` and `node tools/test-launcher.cjs cursor`
   - `claude plugin validate plugins/marrow --strict`
8. Tag the release (`v<version>`).

The Claude Code and Cursor pins follow the `@getmarrow/install` release (`src/pins.js`): the same MCP version, SDK version and integrity. The Codex pins are the ones `@getmarrow/mcp` carries for each Codex plugin version ([docs/PLUGIN-RELEASE.md](docs/PLUGIN-RELEASE.md)).
