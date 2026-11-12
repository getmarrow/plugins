---
name: update
description: Update the Marrow plugin for Claude Code to the latest version in place, with one copy of the hooks. Use when Marrow reports a client update or the user asks to update Marrow.
---

# Update Marrow

Run this one command, and only this command:

```bash
npx @getmarrow/install@latest update
```

The installer finds how Marrow is installed and updates that install. For this plugin it updates the plugin itself and adds no second copy of the hooks. It refuses to go to an older version.

Show the user the version before and the version after that the installer prints. Then tell the user to run `/reload-plugins`, or to restart Claude Code, so the new hooks and Marrow server load.

If the installer says it cannot tell how Marrow is installed, or the command fails, show the user the installer's message and stop. Do not retry it in another shape and do not run any other command in its place.

This skill never runs Marrow's setup, activate or repair commands directly. It never asks for a key, never reads a key file and never prints a key.

To get new versions without asking, the user can turn on auto-update in Claude Code: /plugin, then Marketplaces, then getmarrow, then Enable auto-update.
