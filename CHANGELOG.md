# Changelog

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
- The bridge says whether a port is used by another Superbase bridge or by another program.
- New tests for the settings, the background bridge and command line, the recipes, the update check and the update script, plus Lua tests for every new snippet and recipe.

## 1.3.0

Multiple Roblox clients at once, the web dashboard, `gui_interact`, `screenshot` (Windows) and the installer for 14 AI clients.
