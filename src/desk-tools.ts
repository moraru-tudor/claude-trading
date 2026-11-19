import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * The desk's MCP tools, shared by both connectors:
 *  - local  (src/mcp.ts, stdio, Claude desktop app) → talks to the bot over its local HTTP API
 *  - remote (/mcp/<MCP_SECRET> on the bot's server, claude.ai + Claude phone app) → calls the desk directly
 */
export interface DeskApi {
  state(): Promise<unknown>;
  recap(): Promise<unknown>;
  strategy(): Promise<unknown>;
  setStrategy(patch: Record<string, number>, note: string): Promise<unknown>;
  pause(): Promise<unknown>;
  resume(): Promise<unknown>;
  closeAll(): Promise<unknown>;
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: (e as Error).message }] });
const wrap = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try { return ok(await fn(a)); } catch (e) { return fail(e); }
};

const knob = (d: string) => z.number().optional().describe(d);

export function registerDeskTools(server: McpServer, api: DeskApi) {
  const ro = { readOnlyHint: true, openWorldHint: false };
  server.registerTool("get_desk_state", {
    title: "Desk state",
    description: "Live state of the Solana memecoin trading desk: equity, money put in, P&L, wins/losses, equity curve, open positions, " +
      "what each agent (scanner, safety, analyst, risk, executor) is doing, the latest decisions, the strategy and price-check speed.",
    annotations: ro,
  }, wrap(() => api.state()));

  server.registerTool("get_recap", {
    title: "Session recap",
    description: "Session summary: put in, now worth, multiple, trades, coins, best and worst coin, win rate.",
    annotations: ro,
  }, wrap(() => api.recap()));

  server.registerTool("get_strategy", {
    title: "Strategy",
    description: "Current strategy settings, the allowed range for each (capped by the owner's limits), and Claude's last review.",
    annotations: ro,
  }, wrap(() => api.strategy()));

  server.registerTool("set_strategy", {
    title: "Adjust strategy",
    description: "Change strategy settings. Values are clamped to the owner's limits: size, stop-loss, open positions and liquidity " +
      "can only be made more careful than the .env, never riskier. Applies to new trades. Only call when the user asks for a change.",
    inputSchema: {
      minPositionPct: knob("min % of equity per trade"),
      maxPositionPct: knob("max % of equity per trade"),
      stopLossPct: knob("stop-loss % below entry (new trades)"),
      takeProfitPct: knob("default take-profit %"),
      trailArmPct: knob("gain % at which the trailing stop arms"),
      trailPct: knob("trailing stop distance % from the high"),
      maxHoldMin: knob("max minutes to hold a coin"),
      maxOpenPositions: knob("max coins held at once (0 = no new trades)"),
      minLiquidityUsd: knob("min pool liquidity in USD"),
      minVolM5Usd: knob("min 5-minute volume in USD"),
      note: z.string().optional().describe("why, shown in the decision stream"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, wrap(async (a: Record<string, unknown>) => {
    const { note, ...patch } = a;
    return api.setStrategy(patch as Record<string, number>, typeof note === "string" ? note : "");
  }));

  server.registerTool("pause_desk", {
    title: "Pause desk",
    description: "Stop opening new trades. Open positions keep their stop-loss and take-profit.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, wrap(() => api.pause()));

  server.registerTool("resume_desk", {
    title: "Resume desk",
    description: "Allow the desk to open new trades again.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, wrap(() => api.resume()));

  server.registerTool("close_all_positions", {
    title: "Close all positions",
    description: "Sell every open position at market now and pause the desk. In live mode this sends real swaps from the bot wallet. Only call when the user explicitly asks.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, wrap(() => api.closeAll()));
}
