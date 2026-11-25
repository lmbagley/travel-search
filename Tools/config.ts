/**
 * config.ts — the ONE config source.
 *
 * Resolution: $TRAVEL_SEARCH_CONFIG, else ~/.config/travel-search/config.yaml.
 * The repo ships `config.example.yaml` with the shape and fictional values; your real
 * preferences live outside the repo so it can be shared without leaking anything.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import type { Config } from "./painfulness.ts";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "travel-search", "config.yaml");
export const EXAMPLE_CONFIG_PATH = resolve(dirname(import.meta.path), "..", "config.example.yaml");

export function configPath(): string {
  return process.env.TRAVEL_SEARCH_CONFIG || DEFAULT_CONFIG_PATH;
}

/** "~/x" -> "$HOME/x". Leaves every other string alone. */
export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function parseConfig(src: string, path: string): Config {
  // Bun ships a YAML parser (Bun >= 1.2.21); nothing to install.
  const cfg = Bun.YAML.parse(src) as Config;
  const problems: string[] = [];
  if (!cfg || typeof cfg !== "object") problems.push("file is not a YAML mapping");
  else {
    if (!cfg.painfulness?.hard) problems.push("painfulness.hard is missing");
    if (!cfg.painfulness?.scored) problems.push("painfulness.scored is missing");
    if (!cfg.defaults?.airline) problems.push("defaults.airline is missing");
    if (!cfg.sources || typeof cfg.sources !== "object") problems.push("sources is missing");
  }
  if (problems.length) {
    throw new Error(`travel-search: config at ${path} is invalid — ${problems.join("; ")}`);
  }
  return cfg;
}

export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) {
    // Fail loudly. A default-shaped config would silently rank against somebody
    // else's preferences, which is worse than not running.
    throw new Error(
      `travel-search: no config at ${path}. Copy ${EXAMPLE_CONFIG_PATH} there and edit it ` +
        `(or set TRAVEL_SEARCH_CONFIG). Refusing to rank against invented preferences.`,
    );
  }
  return parseConfig(readFileSync(path, "utf8"), path);
}
