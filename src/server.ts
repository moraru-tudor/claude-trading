import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import type { Desk } from "./core.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

export function startServer(desk: Desk) {
  const clients = new Set<http.ServerResponse>();
  const send = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  desk.on("toast", (t) => send("toast", t));
  setInterval(() => clients.size && send("state", desk.snapshot()), 1000).unref();

  const authed = (req: http.IncomingMessage) => {
    if (!config.dashboardToken) return true;
    const u = new URL(req.url ?? "/", "http://x");
    return u.searchParams.get("token") === config.dashboardToken || req.headers["x-desk-token"] === config.dashboardToken;
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!authed(req)) return json(401, { error: "bad token" });

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
    if (u.pathname === "/api/state") return json(200, desk.snapshot());
    if (u.pathname === "/api/recap") return json(200, desk.recap());
    if (req.method === "POST" && u.pathname === "/api/pause") {
      desk.setPaused(true);
      return json(200, { ok: true });
    }
    if (req.method === "POST" && u.pathname === "/api/resume") {
      desk.setPaused(false);
      return json(200, { ok: true });
    }
    if (req.method === "POST" && u.pathname === "/api/close-all") {
      desk.setPaused(true, "closed all from dashboard");
      await desk.closeAll();
      return json(200, { ok: true });
    }
    json(404, { error: "not found" });
  });

  server.listen(config.port, config.host, () => {
    const q = config.dashboardToken ? `?token=${config.dashboardToken}` : "";
    const host = config.host === "0.0.0.0" ? "<this-computer-ip>" : config.host;
    console.log(`\n  ▸ dashboard  http://${host}:${config.port}/${q}\n`);
  });
  return server;
}
