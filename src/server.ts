import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import type { Desk } from "./core.js";
import { registerDeskTools, type DeskApi } from "./desk-tools.js";
import { bounds } from "./strategy.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : undefined;
}

/** The desk as seen by tools: direct calls, no HTTP hop. */
function directApi(desk: Desk): DeskApi {
  return {
    state: async () => desk.snapshot(),
    recap: async () => desk.recap(),
    strategy: async () => ({ ...desk.strategy(), allowedRanges: bounds }),
    setStrategy: async (patch, note) => {
      const changes = desk.setStrategy(patch, note ? `you via Claude (${note})` : "you via Claude");
      return { changes, strategy: desk.strategy().strategy };
    },
    pause: async () => (desk.setPaused(true, "paused from Claude"), { ok: true }),
    resume: async () => (desk.setPaused(false), { ok: true }),
    closeAll: async () => { desk.setPaused(true, "closed all from Claude"); await desk.closeAll(); return { ok: true }; },
  };
}

const MANIFEST = JSON.stringify({
  name: "Trading Desk", short_name: "Desk", display: "standalone", background_color: "#ffffff", theme_color: "#ffffff",
  start_url: ".", icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
});
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0c0c12"/><path d="M12 44l12-12 9 8 19-20" stroke="#31c47c" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function startServer(desk: Desk) {
  const api = directApi(desk);
  const clients = new Set<http.ServerResponse>();
  const send = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  desk.on("toast", (t) => send("toast", t));
  setInterval(() => clients.size && send("state", desk.snapshot()), 500).unref();

  const authed = (req: http.IncomingMessage, u: URL) => {
    if (!config.dashboardToken) return true;
    const given = u.searchParams.get("token") ?? String(req.headers["x-desk-token"] ?? "");
    return same(given, config.dashboardToken);
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      // health check for the cloud host (no data)
      if (u.pathname === "/healthz") return json(200, { ok: true });

      // remote connector for claude.ai and the Claude phone app; the secret path is the password
      if (config.mcpSecret && u.pathname.startsWith("/mcp/")) {
        if (!same(u.pathname.slice(5), config.mcpSecret)) return json(404, { error: "not found" });
        const mcp = new McpServer({ name: "trading-desk", version: "0.2.0" });
        registerDeskTools(mcp, api);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => { void transport.close(); void mcp.close(); });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, req.method === "POST" ? await readJson(req) : undefined);
        return;
      }

      if (u.pathname === "/manifest.webmanifest") { res.writeHead(200, { "content-type": "application/manifest+json" }); return res.end(MANIFEST); }
      if (u.pathname === "/icon.svg") { res.writeHead(200, { "content-type": "image/svg+xml" }); return res.end(ICON); }

      if (!authed(req, u)) return json(401, { error: "bad token" });

      if (u.pathname === "/" || u.pathname === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return fs.createReadStream(path.join(PUBLIC, "index.html")).pipe(res);
      }
      if (u.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`event: state\ndata: ${JSON.stringify(desk.snapshot())}\n\n`);
        clients.add(res);
        req.on("close", () => void clients.delete(res));
        return;
      }
      if (u.pathname === "/api/state") return json(200, await api.state());
      if (u.pathname === "/api/recap") return json(200, await api.recap());
      if (u.pathname === "/api/strategy" && req.method === "GET") return json(200, await api.strategy());
      if (req.method === "POST") {
        if (u.pathname === "/api/strategy") {
          const { note, ...patch } = ((await readJson(req)) ?? {}) as Record<string, unknown>;
          return json(200, await api.setStrategy(patch as Record<string, number>, typeof note === "string" ? note : ""));
        }
        if (u.pathname === "/api/pause") return json(200, await api.pause());
        if (u.pathname === "/api/resume") return json(200, await api.resume());
        if (u.pathname === "/api/close-all") return json(200, await api.closeAll());
      }
      json(404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) json(500, { error: (e as Error).message });
    }
  });

  server.listen(config.port, config.host, () => {
    const q = config.dashboardToken ? `?token=${config.dashboardToken}` : "";
    const host = config.host === "0.0.0.0" ? "<this-server>" : config.host;
    console.log(`\n  ▸ dashboard  http://${host}:${config.port}/${q}`);
    if (config.mcpSecret) console.log(`  ▸ connector  https://<your-public-address>/mcp/<MCP_SECRET>  (add in claude.ai → Settings → Connectors)`);
    console.log();
  });
  return server;
}
