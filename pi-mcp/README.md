# pi-mcp

MCP client extension for [Pi](https://github.com/earendil-works/pi). Connects to Model Context Protocol servers and exposes their tools to the agent.

## Install

In your pi project:

```bash
pi install git:github.com/Denveous/pi-mono-exts
```

Or load only this extension from a local checkout:

```bash
pi install ./pi-mcp
```

## Configure

Create `.pi/mcp.json` in your project (or `~/.pi/agent/mcp.json` for global):

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" }
    },
    "remote": {
      "url": "http://localhost:8080/mcp"
    },
    "remote-sse": {
      "url": "http://localhost:8080/sse",
      "transport": "sse",
      "headers": { "Authorization": "Bearer token" }
    }
  }
}
```

Each key under `servers` is a name you pick. Options per server:

| Field | Description |
|-------|-------------|
| `command` | Executable to run (stdio transport) |
| `args` | Arguments passed to the command |
| `env` | Extra environment variables |
| `cwd` | Working directory for the spawned process |
| `url` | HTTP endpoint (uses streamable HTTP by default) |
| `transport` | `"sse"` or `"streamable-http"` (default). Only used with `url` |
| `headers` | HTTP headers sent with each request |

MCP tools show up prefixed as `mcp_{server}_{tool}` in pi. The LLM sees them like any other tool.

## Commands

| Command | What it does |
|---------|-------------|
| `/mcp` | List connected servers and tool counts |
| `/mcp-reconnect` | Disconnect and reconnect all servers |

## License

MIT
