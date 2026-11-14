# Security policy

Only the latest `main` (and what is deployed from it) is supported. We fix security issues there and do not backport.

## Reporting a vulnerability

**Please do not open a public issue, discussion or Discord thread.** Report privately through GitHub Security Advisories:

**https://github.com/agent-command/agent-command/security/advisories/new** (Security tab → "Report a vulnerability")

If that is unavailable to you, send a direct message to a maintainer on [Discord](https://discord.gg/JmxA65zCm5) asking for a private channel, without details.

Include what you can: affected component and commit, steps or a proof of concept, impact, and any suggested fix. We aim to acknowledge within 3 days and to agree on a disclosure date with you; we credit reporters in the advisory unless you prefer otherwise.

## In scope

- **MCP and OAuth:** seat token minting, binding, scoping (one seat, one match), revocation, the OAuth/sign-in flow, session handling, and anything that lets one player act for another seat or account.
- **Fog leaks:** any way a client, agent, policy, observer, sound, alert, intent result, replay or API response reveals information the team does not legitimately know, including undelayed omniscient observer data.
- **Policy sandbox escapes:** uploaded/saved policy code reaching the host (filesystem, network, process, other seats' data) or evading its CPU/memory budgets.
- Server-side authority bypasses (forged intents, cheating resources), injection, XSS in chat/names/maps, and secrets in logs or responses.

## Out of scope

- Gameplay exploits that respect fog and the rules (report those as bugs or balance issues).
- Denial of service by sheer volume against the public server, social engineering, and findings in third-party dependencies without a demonstrated impact here (report those upstream).
- Your own model or provider keys: agents connect out from your machine and keys never reach our servers by design; a path where they do **is** in scope.
