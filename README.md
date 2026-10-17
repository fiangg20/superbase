# Superbase - Coming Soon

Superbase connects AI assistants to a live Roblox session. Through the Model Context Protocol (MCP) an AI can read your console and script errors, inspect the instance tree and run Lua inside the running game. It always knows whether Roblox is actually connected, because every tool result starts with a status line.

```
AI client ──stdio──▶ mcp-server.js ──HTTP──▶ bridge.js ◀──WebSocket── client.lua (in your executor)
```

Everything runs on your own computer and listens on `127.0.0.1` only.

## What you need

- Node.js 18 or newer
- A Roblox executor that supports `WebSocket.connect` and `loadstring`
- Any AI client that supports MCP servers over stdio (see "Connect your AI" below)

## Quick start

1. Put `bridge.js`, `mcp-server.js` and `package.json` in one folder and run `npm install`.
2. Create a token: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
3. Start the bridge with that token:
   - PowerShell: `$env:BRIDGE_TOKEN="<token>"; node bridge.js`
   - macOS or Linux: `BRIDGE_TOKEN=<token> node bridge.js`
4. Open `client.lua`, set `CONFIG.Token` to the same token, join a game and execute it in your executor. The console shows `[Superbase] Connected and authenticated`.
5. Add Superbase to your AI client (next section) and ask it to run `roblox_status`.

The default port is `9731`. To change it, set `BRIDGE_PORT` for the bridge and the MCP server, and change `CONFIG.Url` in `client.lua`.

## Connect your AI

Use your own path and token in every example. The server command is always `node` with the path to `mcp-server.js`, and the environment needs `BRIDGE_TOKEN` (and `BRIDGE_PORT` if you changed it).

Only Claude Desktop has been tested. The other formats follow each client's documented MCP configuration and may change, so check the client's own docs if one does not work.

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "superbase": {
      "command": "node",
      "args": ["C:\\path\\to\\superbase\\mcp-server.js"],
      "env": { "BRIDGE_TOKEN": "<token>", "BRIDGE_PORT": "9731" }
    }
  }
}
```

**Claude Code**

```
claude mcp add --env BRIDGE_TOKEN=<token> --env BRIDGE_PORT=9731 superbase -- node /path/to/superbase/mcp-server.js
```

**Cursor** (`.cursor/mcp.json` or `~/.cursor/mcp.json`), **Windsurf** (`~/.codeium/windsurf/mcp_config.json`) and **Gemini CLI** (`~/.gemini/settings.json`) use the same shape as Claude Desktop. Note that since June 18, 2026 Gemini CLI no longer serves Google AI Pro, Ultra or free individual accounts. It still works with an API key or an enterprise license, and everyone else should use the Antigravity CLI:

```json
{
  "mcpServers": {
    "superbase": {
      "command": "node",
      "args": ["/path/to/superbase/mcp-server.js"],
      "env": { "BRIDGE_TOKEN": "<token>", "BRIDGE_PORT": "9731" }
    }
  }
}
```

**Antigravity**: open the "…" menu at the top of the agent side panel, choose MCP Servers, then Manage MCP Servers and View raw config. That opens `mcp_config.json` (the docs list `~/.gemini/config/mcp_config.json` for all projects and `.agents/mcp_config.json` for one workspace). In the Antigravity CLI, type `/mcp` to open the MCP manager, or edit the same file directly. Use the same shape as Claude Desktop, then click Refresh in Manage MCP Servers:

```json
{
  "mcpServers": {
    "superbase": {
      "command": "node",
      "args": ["/path/to/superbase/mcp-server.js"],
      "env": { "BRIDGE_TOKEN": "<token>", "BRIDGE_PORT": "9731" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`)

```json
{
  "servers": {
    "superbase": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/superbase/mcp-server.js"],
      "env": { "BRIDGE_TOKEN": "<token>", "BRIDGE_PORT": "9731" }
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.superbase]
command = "node"
args = ["/path/to/superbase/mcp-server.js"]
env = { BRIDGE_TOKEN = "<token>", BRIDGE_PORT = "9731" }
```

Cloud hosted AI chats cannot reach `localhost`, so they cannot use Superbase. An AI that has no MCP support but can run shell commands can use the HTTP API below.

## Tools

| Tool | What it does |
| --- | --- |
| `roblox_status` | Pings the Roblox client and reports the connection state, place, executor and latency. Call it first. |
| `get_logs` | Reads console output (filter by `level`, set a `limit`). |
| `get_errors` | Reads script errors with stack traces. |
| `execute_lua` | Runs Lua in the executor and returns the values or the error with a traceback. |
| `inspect_instance` | Reads the class, properties and children of an instance by dotted path. |
| `clear_logs` | Clears the stored logs and errors. |

Every result starts with a status line such as `[Superbase] ● connected — place 123456, Solara 3.2, 12 ms`.

## Connection states

| State | Meaning | What the AI tells you |
| --- | --- | --- |
| `connected` | A Roblox client is connected and answered a ping. | Nothing, all tools work. |
| `waiting_for_roblox` | The bridge runs but no game is connected. | Join a game and execute `client.lua`. |
| `unresponsive` | A client is connected but did not answer a ping. | The game may be frozen, loading or closing. |
| `bridge_offline` | The bridge is not running. | Start `bridge.js`. |
| `token_mismatch` | The MCP config token differs from the bridge token. | Use the same token in both. |
| `missing_token` | No token is set in the MCP config. | Add `BRIDGE_TOKEN` to the MCP config. |

The bridge also pings the client every 10 seconds and drops it if it stays silent for 30 seconds, so a closed game does not look connected.

## HTTP API

Every request needs the header `x-bridge-token: <token>`.

| Request | Purpose |
| --- | --- |
| `GET /status` | Connection info. Add `?probe=1` to ping the client first. |
| `GET /logs?limit=100&level=warn` | Stored console output. |
| `GET /errors?limit=50` | Stored script errors. |
| `POST /exec` with `{ "code": "return 1" }` | Run Lua in the executor. |
| `POST /inspect` with `{ "path": "game.Workspace", "properties": ["Name"] }` | Inspect an instance. |
| `POST /clear` | Clear stored logs and errors. |

## Security

- `execute_lua` is remote code execution inside your executor. Only connect AI clients you trust and read the code before approving it.
- The bridge binds to `127.0.0.1`, requires the token on every request, checks the `Host` header and rejects connections that carry a web page `Origin`. Never expose the port to a network or the internet.
- Keep the token private. Anyone who has it and can reach the port can run code in your game.

## Troubleshooting

- `Cannot find module 'ws'`: run `npm install` in the folder that holds `bridge.js`.
- The executor console shows `401 Unauthorized`: `CONFIG.Token` in `client.lua` differs from the bridge token.
- `Unable to connect` in the executor console: the bridge is not running, or the port differs from `CONFIG.Url`.
- The port is already in use: pick another one and change it in the bridge, the MCP config and `CONFIG.Url`.
- The AI reports `waiting_for_roblox`: the client stops when you leave or rejoin a game, so execute `client.lua` again (or put it in your executor's autoexec folder).
