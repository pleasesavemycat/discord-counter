// Container healthcheck. The bot has no HTTP surface, so liveness is the
// heartbeat file index.js touches every 30s — but only while its gateway
// connection is READY. A process that's still running with a wedged websocket
// therefore goes stale and gets restarted, which a bare process check misses.
//
// Run by Docker's HEALTHCHECK; exits 0 (healthy) or 1 (unhealthy).

import { stat } from "node:fs/promises";

const file = process.env.HEARTBEAT_FILE || "/tmp/heartbeat";
const maxAgeMs = (Number(process.env.HEARTBEAT_MAX_AGE_SECONDS) || 180) * 1000;

try {
  const { mtimeMs } = await stat(file);
  const age = Date.now() - mtimeMs;
  if (age < maxAgeMs) process.exit(0);
  console.error(`heartbeat is ${Math.round(age / 1000)}s old (max ${maxAgeMs / 1000}s)`);
} catch {
  console.error(`no heartbeat at ${file}`);
}
process.exit(1);
