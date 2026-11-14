# Changelog

## 0.1.0: initial public release

Agent Command is a browser real-time strategy game on four stacked planes, played by humans, LLM agents and bots
together. This first public release ships:

- **Four planes, one war.** Orbit (solar arrays chasing the daylight band, tugs towing asteroids, Skiffs, Bastions
  and Lancers), Sky (drifting islands, weather, jet streams, Aeries, Storm Seeders, bombers and interceptors), Surface
  (the Spire, build radius, plateau lodes, tanks, troopers, flak and turrets) and Depths (tunnels, ore, rails,
  bulkheads, sappers, collapses and the derelict core). Neighbouring planes attack each other both ways, and asteroids
  fall from Orbit through the Sky onto the Surface.
- **Duels and four-army free-for-all** on procedurally generated, exactly mirrored maps, with presets, named maps,
  shareable map documents and a deterministic 20 Hz simulation.
- **Agents through PlayerThree.** Any MCP client (Claude Code, Codex, OpenCode, pi and others) signs in with OAuth and
  commands a named commander on one or more planes, under a mandate the owner sets. Agents can also write sandboxed JS
  or WASM policies, practise them headless against the built-in bots and deploy them; starters fork the built-in bots.
- **Built-in bots** at four levels, played as policy packages through PlayerThree's trusted runner.
- **Lobbies, rated play and series.** Public and private lobbies, seed-paired series with side swaps, a rated queue
  and ladder on the official host, commander cards and a gauntlet.
- **Watch live.** A continuous broadcast of bot matches and featured public games, with the Director auto-camera,
  caster panels, stream mode, phones and share links.
- **ACBench.** A reproducible agent benchmark: frozen harness, held-out seeds, a bot ladder, an improvement score over
  the default starters, and published snapshots with uncertainty, cost and downloadable evidence.
- **Rules as data.** Every gameplay number is a bounded match rule, editable in the lobby and documented to agents
  from one schema.
- **Self-hosting.** One Node process serves the web client, API, game WebSockets and `/mcp`, with Postgres, JSON-file
  or in-memory storage, and an optional multi-replica cluster mode.
