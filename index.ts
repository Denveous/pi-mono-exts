import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

type ServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  transport?: "sse" | "streamable-http";
};

type Config = {
  servers: Record<string, ServerConfig>;
};

type Connected = {
  name: string;
  client: Client;
  transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
};

const registered = new Set<string>();
let connected: Connected[] = [];
let pi: ExtensionAPI;

async function loadConfig(cwd: string): Promise<Config> {
  const paths = [
    join(cwd, ".pi", "mcp.json"),
    join(homedir(), ".pi", "agent", "mcp.json"),
  ];
  for (const p of paths) {
    try {
      const raw = await readFile(p, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed?.servers) return parsed;
    } catch { /* skip */ }
  }
  return { servers: {} };
}

function makeTransport(cfg: ServerConfig) {
  if (cfg.url) {
    const url = new URL(cfg.url);
    const opts = { requestInit: { headers: cfg.headers } };
    return cfg.transport === "sse"
      ? new SSEClientTransport(url, opts)
      : new StreamableHTTPClientTransport(url, opts);
  }
  if (!cfg.command) throw new Error("need 'command' or 'url'");
  return new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    env: cfg.env as Record<string, string> | undefined,
    cwd: cfg.cwd,
    stderr: "pipe",
  });
}

function textify(block: Record<string, unknown>): string {
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "image" && typeof block.data === "string") return `[image: ${block.mimeType ?? "unknown"}]`;
  return JSON.stringify(block);
}

async function connectOne(name: string, cfg: ServerConfig) {
  const client = new Client({ name: `pi-mcp-${name}`, version: "0.1.0" });
  const transport = makeTransport(cfg);
  await client.connect(transport);

  const { tools } = await client.listTools();

  for (const tool of tools) {
    const fullName = `mcp_${name}_${tool.name}`;
    if (registered.has(fullName)) continue;
    registered.add(fullName);

    const schema = tool.inputSchema?.type === "object"
      ? tool.inputSchema as unknown as TSchema
      : Type.Object({});

    pi.registerTool({
      name: fullName,
      label: (tool.annotations as Record<string, string> | undefined)?.title ?? tool.name,
      description: tool.description ?? `${name}/${tool.name}`,
      parameters: schema,
      async execute(_id: string, args: Record<string, unknown>, signal?: AbortSignal) {
        const result = await client.callTool(
          { name: tool.name, arguments: args },
          undefined,
          signal ? { signal } : undefined,
        );
        const content = (result.content as Record<string, unknown>[]).map(textify).join("\n");
        return {
          content: [{ type: "text" as const, text: content }],
          details: { server: name, tool: tool.name },
          isError: (result as Record<string, unknown>).isError === true,
        };
      },
    });
  }

  return { name, client, transport };
}

async function disconnectAll() {
  for (const s of connected) {
    try { await s.client.close(); await s.transport.close(); } catch { /* ok */ }
  }
  connected = [];
}

function countTools(serverName: string) {
  return Array.from(registered).filter(n => n.startsWith(`mcp_${serverName}_`)).length;
}

export default function (api: ExtensionAPI) {
  pi = api;

  pi.on("session_start", async (_, ctx) => {
    const { servers } = await loadConfig(ctx.cwd);
    for (const [name, cfg] of Object.entries(servers)) {
      try {
        connected.push(await connectOne(name, cfg));
        ctx.ui.notify(`mcp: ${name} connected (${countTools(name)} tools)`, "info");
      } catch (err) {
        ctx.ui.notify(`mcp: ${name} failed — ${err instanceof Error ? err.message : err}`, "error");
      }
    }
  });

  pi.on("session_shutdown", disconnectAll);

  pi.registerCommand("mcp", {
    description: "Show connected MCP servers",
    handler: async (_, ctx) => {
      if (!connected.length) { ctx.ui.notify("no MCP servers connected", "info"); return; }
      const lines = connected.map(s => `${s.name} (${countTools(s.name)} tools)`);
      ctx.ui.notify(`mcp servers: ${lines.join(", ")}`, "info");
    },
  });

  pi.registerCommand("mcp-reconnect", {
    description: "Reconnect all MCP servers",
    handler: async (_, ctx) => {
      await disconnectAll();
      const { servers } = await loadConfig(ctx.cwd);
      for (const [name, cfg] of Object.entries(servers)) {
        try {
          connected.push(await connectOne(name, cfg));
          ctx.ui.notify(`mcp: ${name} connected (${countTools(name)} tools)`, "info");
        } catch (err) {
          ctx.ui.notify(`mcp: ${name} failed — ${err instanceof Error ? err.message : err}`, "error");
        }
      }
    },
  });
}
