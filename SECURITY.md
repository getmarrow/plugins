# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue or pull request for them.

1. Use GitHub's private vulnerability reporting: open the [Security tab](https://github.com/getmarrow/plugins/security) of this repository and choose "Report a vulnerability".
2. Or email the contact published in [security.txt](https://getmarrow.ai/.well-known/security.txt): `Contact: mailto:security@getmarrow.ai`.

Please include what you found, the version or commit, and the steps to reproduce it. Do not include real credentials, API keys or other people's data; use test accounts and dummy values.

## Scope

In scope:

- the Marrow plugin packages and marketplace manifests in this repository, for Claude Code, Cursor and Codex;
- the commands the plugin hooks run on a user's machine, and the package versions the plugins pin and start;
- the skill text the plugins ship, which is loaded into an agent's context;
- the GitHub Actions workflows of this repository, and anything that could change what `/plugin marketplace add getmarrow/plugins` installs or updates.

Also welcome through the same contact: findings about the hosted Marrow AI service and website at getmarrow.ai.

Out of scope:

- denial-of-service or volume testing, spam, social engineering and physical attacks;
- problems that need an already compromised machine, account or key;
- software we do not publish (MCP clients, agent hosts, npm, GitHub): please report those to their owners;
- scanner output without a demonstrated impact.

## Testing rules

Test only against your own installs, keys and accounts. Do not access other people's data, and stop at the minimum needed to show the problem. Please check the latest release first, and keep the details private until a fix has been released.
