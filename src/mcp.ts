/**
 * Local MCP server ("trading-desk") that lets the Claude desktop app – and the desk page published
 * inside Claude – read the running desk and press its buttons.
 *
 * It is a thin bridge: the trading bot keeps running on its own (`npm run paper` / `npm run live`),
 * and this process only forwards requests to the bot's local HTTP API. Claude never sees the wallet key.
 *
 * stdout is reserved for the MCP protocol, so this file logs only to stderr and does not load dotenv's
 * banner. Configure with env vars in claude_desktop_config.json:
 *   DESK_URL         default http://127.0.0.1:8787
 *   DASHBOARD_TOKEN  same token as the bot's .env, if you set one
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const DESK_URL = (process.env.DESK_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const TOKEN = process.env.DASHBOARD_TOKEN || "";

async function desk(path: string, method: "GET" | "POST" = "GET") {
  let res: Response;
  try {
    res = await fetch(DESK_URL + path, {
      method,
      headers: TOKEN ? { "x-desk-token": TOKEN } : {},
      signal: AbortSignal.timeout(method === "POST" ? 120_000 : 10_000),
    });
  } catch {
    throw new Error(`The trading desk is not running at ${DESK_URL}. Start it with "npm run paper" (or "npm run live") in the claude-trading folder.`);
  }
  if (!res.ok) throw new Error(`Desk answered HTTP ${res.status}${res.status === 401 ? " (DASHBOARD_TOKEN does not match the bot's .env)" : ""}`);
  return res.json();
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: (e as Error).message }] });
const run = (fn: () => Promise<unknown>) => async () => {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
};

const server = new McpServer({ name: "trading-desk", version: "0.1.0" });

server.registerTool(
  "get_desk_state",
  {
    title: "Desk state",
    description:
      "Live state of the Solana memecoin trading desk: equity, money put in, P&L, win/loss count, equity curve, " +
      "open positions, what each of the 5 agents (scanner, safety, analyst, risk, executor) is doing, and the latest decisions.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run(() => desk("/api/state")),
);

server.registerTool(
  "get_recap",
  {
    title: "Session recap",
    description: "Session summary: put in, now worth, multiple, trades, coins, best and worst coin, win rate.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  run(() => desk("/api/recap")),
);

server.registerTool(
  "pause_desk",
  {
    title: "Pause desk",
    description: "Stop opening new trades. Open positions keep their stop-loss and take-profit.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  run(() => desk("/api/pause", "POST")),
);

server.registerTool(
  "resume_desk",
  {
    title: "Resume desk",
    description: "Allow the desk to open new trades again.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  run(() => desk("/api/resume", "POST")),
);

server.registerTool(
  "close_all_positions",
  {
    title: "Close all positions",
    description: "Sell every open position at market now and pause the desk. In live mode this sends real swaps from the bot wallet.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  run(() => desk("/api/close-all", "POST")),
);

await server.connect(new StdioServerTransport());
console.error(`[trading-desk mcp] bridging to ${DESK_URL}`);
