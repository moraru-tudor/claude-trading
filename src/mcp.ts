/**
 * Local connector ("trading-desk") for the Claude DESKTOP app, over stdio.
 * A thin bridge: the bot keeps running on its own, this process forwards to its HTTP API.
 * Claude never sees the wallet key.
 *
 * stdout is reserved for the MCP protocol; log only to stderr. Env (set in claude_desktop_config.json):
 *   DESK_URL         default http://127.0.0.1:8787  (or your cloud desk, e.g. https://my-desk.fly.dev)
 *   DASHBOARD_TOKEN  same token as the bot's .env, if set
 *
 * For the PHONE (claude.ai / Claude mobile), use the remote connector at /mcp/<MCP_SECRET> instead.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDeskTools } from "./desk-tools.js";

const DESK_URL = (process.env.DESK_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const TOKEN = process.env.DASHBOARD_TOKEN || "";

async function desk(path: string, method: "GET" | "POST" = "GET", body?: unknown) {
  let res: Response;
  try {
    res = await fetch(DESK_URL + path, {
      method,
      headers: { ...(TOKEN ? { "x-desk-token": TOKEN } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(method === "POST" ? 120_000 : 10_000),
    });
  } catch {
    throw new Error(`The trading desk is not running at ${DESK_URL}. Start it with "npm run paper" (or "npm run live") in the claude-trading folder.`);
  }
  if (!res.ok) throw new Error(`Desk answered HTTP ${res.status}${res.status === 401 ? " (DASHBOARD_TOKEN does not match the bot's .env)" : ""}`);
  return res.json();
}

const server = new McpServer({ name: "trading-desk", version: "0.2.0" });
registerDeskTools(server, {
  state: () => desk("/api/state"),
  recap: () => desk("/api/recap"),
  strategy: () => desk("/api/strategy"),
  setStrategy: (patch, note) => desk("/api/strategy", "POST", { ...patch, note }),
  pause: () => desk("/api/pause", "POST"),
  resume: () => desk("/api/resume", "POST"),
  closeAll: () => desk("/api/close-all", "POST"),
});

await server.connect(new StdioServerTransport());
console.error(`[trading-desk mcp] bridging to ${DESK_URL}`);
