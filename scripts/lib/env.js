// Minimal .env loader (no dependency, Node 18-compatible — process.loadEnvFile
// only exists from Node 20.6+). Loads HR_skill/.env once; real env vars
// already set (e.g. by the shell or CI) always win.
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir   = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(__dir, "../../.env");

let _loaded = false;

export function loadEnvFile() {
  if (_loaded) return;
  _loaded = true;
  if (!existsSync(ENV_FILE)) return;
  const text = readFileSync(ENV_FILE, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let [, key, val] = m;
    val = val.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
