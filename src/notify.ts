import { config } from "./config.js";

/**
 * Push notifications to your phone through ntfy (free, open source, no account needed):
 * install the ntfy app (iOS / Android), subscribe to your NTFY_TOPIC, done.
 * Pick a long random topic name: anyone who knows it can read your trade alerts.
 * Failures are ignored: an alert must never block trading.
 */
let sentThisMinute = 0;
setInterval(() => (sentThisMinute = 0), 60_000).unref();

export function notify(message: string, opts: { title?: string; tags?: string; priority?: 1 | 2 | 3 | 4 | 5 } = {}) {
  if (!config.ntfyTopic || sentThisMinute >= 20) return;
  sentThisMinute++;
  const headers: Record<string, string> = { Title: `Trading desk${opts.title ? " · " + opts.title : ""} (${config.mode})` };
  if (opts.tags) headers.Tags = opts.tags;
  if (opts.priority) headers.Priority = String(opts.priority);
  fetch(`${config.ntfyServer.replace(/\/$/, "")}/${encodeURIComponent(config.ntfyTopic)}`, {
    method: "POST",
    body: message,
    headers,
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}
