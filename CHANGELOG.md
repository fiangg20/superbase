# Changelog

## 1.3.2

Setup and starting the client:

- Setup is `git clone`, `cd superbase`, `npm run setup`. The installer installs the dependency itself, and the bridge starts by itself when the AI needs it, so there is no separate `npm install` or `npm start` step. The setup prints the line for your executor at the end.
- `roblox/loader.lua` (`npm run loader`): downloads the client with `game:HttpGet` and falls back to the executor's `request`, `http_request`, `syn.request` or `http.request` when `HttpGet` is blocked. It retries every 3 seconds until the bridge answers and never starts two loops.
- `npm run autoexec` (also offered by `npm run setup`): puts the loader in your executor's autoexec folder. It finds the folder with a probe file that has a random name, written through the executor into its `workspace` folder. Superbase searches the disk for it, goes up from the workspace and looks for a folder with `autoexec` in its name. `--dir` gives the folder by hand, `--dry-run` and `--remove` are available.

Connection:

- HTTP long polling for executors without `WebSocket` (or with it blocked). `CONFIG.Transport` is `auto` (default), `websocket` or `polling`, and `CONFIG.PollWait` sets the wait. New bridge routes: `POST /poll/hello`, `GET /poll/next`, `POST /poll/send`, `POST /poll/close`. `/clients` reports the transport of each client.
- Several computers: the new `host` setting (`SUPERBASE_HOST`) lets the bridge listen on a network address and tells the MCP server and the loader where to find it. A bridge that other computers can reach refuses to start without a token (16 characters or more). The `Origin` check stays on. The MCP server never starts a remote bridge. Any number of MCP servers can share one bridge.
- In token mode `GET /client.lua?token=<token>` now serves the client with the token and the address filled in, so the one line loader works in token mode too, and the reconnect after a teleport keeps working.

Tools (23 tools became 24):

- `semantic_search`: find code by meaning with embeddings from a local Ollama (`embeddinggemma` by default, settings `ollamaUrl` and `embedModel`). Actions `index`, `search`, `status` and `clear`. The index is a file per place in `.superbase/semantic/`. New snippet `dump_scripts.lua` pages through the script sources.
- `remote_spy` can block remotes: actions `block` and `unblock` with `remotes` (names or full paths) drop the game's calls before they reach the server. Blocking works without recording, calls made by Superbase itself are not blocked unless `include_own` is set, and blocked calls are marked in the recording.

Other:

- The status line uses a colon instead of a dash (`connected: c1 (Player1), ...`).
- New tests for the loader, the autoexec search (with a fake disk), HTTP polling (a real bridge and a fake polling client, plus the Lua side), the network mode and semantic search (with a fake Ollama). The Lua mock covers the polling protocol, remote blocking and `dump_scripts`.
- The teleport of `character_control` keeps the character's pivot offset (a fix to the 1.3.1 behavior).

## 1.3.1

New tools (18 tools became 23):

- `player_info`: list the players with team, position, distance, health and, with `details`, speed, tools, leaderstats and attributes. `action: character` shows one player in full.
- `character_control`: teleport your character, or walk it with the humanoid, to a position, a player or an instance.
- `stats`: frame rate (average, minimum, 1% low), stutters, physics FPS, memory, ping, network traffic, instance counts and short notes about what looks wrong.
- `snapshot`: save the state of part of the game in a named slot and diff it later (added, removed and changed instances with property, before and after).
- `recipes`: list, run and save reusable Lua scripts kept as files in the new `recipes/` folder. Five recipes are included. The dashboard has a recipe picker in the Run Lua tab, and the bridge serves them at `GET /recipes`.

Connection:

- The client stays connected through teleports. It queues itself with `queue_on_teleport`, tells the bridge the disconnect is a teleport, skips the intro in the new place and shows one "Reconnected after teleport" toast. New client options: `AutoReconnectOnTeleport` and `LoaderUrl`. While a teleport is in progress the AI is told to wait instead of asking you to run the loader.
- The MCP server starts the bridge in the background when the AI needs it and nobody started it, and says so once. If that fails, the status line gives the reason. Turn it off with `autostart: false`.
- New commands: `npm run start:bg`, `stop`, `status`, `logs` (also available as the `superbase` command). The background bridge logs to `.superbase/bridge.log`.

Settings and updates:

- `superbase.config.json` (see `superbase.config.example.json`) for port, token, autostart, update check, recipes folder, screenshot defaults and more. Environment variables still win. Mistakes in the file give warnings and never stop anything.
- The bridge checks GitHub for a newer release at start (at most every 12 hours), shows it in its output and in `/status`, and the AI mentions it once. `npm run update` updates a git checkout (`git pull --ff-only`, then `npm install`). `"updateCheck": false` turns the check off.

Other:

- `GET /status` also reports `bridgeVersion`, `bridgePid`, `lastDisconnectReason` and `update`.
- `character_control` teleports the root part to the target (and keeps the character's rotation), instead of the model pivot, which sits about 1.5 studs higher on an R6 rig.
- The bridge says whether a port is used by another Superbase bridge or by another program.
- New tests for the settings, the background bridge and command line, the recipes, the update check and the update script, plus Lua tests for every new snippet and recipe.

## 1.3.0

Multiple Roblox clients at once, the web dashboard, `gui_interact`, `screenshot` (Windows) and the installer for 14 AI clients.
