import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
export const CONFIG_JSON = resolve(__dir, "../../config/config.json");

export function loadConfig() {
  if (!existsSync(CONFIG_JSON)) return {};
  try { return JSON.parse(readFileSync(CONFIG_JSON, "utf8")); }
  catch { return {}; }
}

export function saveConfig(cfg) {
  mkdirSync(dirname(CONFIG_JSON), { recursive: true });
  writeFileSync(CONFIG_JSON, JSON.stringify(cfg, null, 2), "utf8");
}

function deepMerge(a, b) {
  if (Array.isArray(b)) return b;
  if (typeof b !== "object" || b === null) return b;
  const out = { ...(a && typeof a === "object" && !Array.isArray(a) ? a : {}) };
  for (const k of Object.keys(b)) out[k] = deepMerge(out[k], b[k]);
  return out;
}

// Shallow-patch config.json (deep-merged with existing content) and persist it.
export function updateConfig(patch) {
  const merged = deepMerge(loadConfig(), patch);
  saveConfig(merged);
  return merged;
}

export function isConfigured() {
  const cfg = loadConfig();
  return Boolean(cfg.hr?.autoLogIssue);
}
