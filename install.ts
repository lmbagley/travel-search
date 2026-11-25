#!/usr/bin/env bun
/**
 * install.ts — install travel-search as a PAI / LifeOS / Claude Code skill.
 *
 *   bun install.ts            copy the skill into $CLAUDE_DIR/skills/TravelSearch
 *   bun install.ts --link     symlink it to this checkout instead (edits go live; for developers)
 *
 * $CLAUDE_DIR defaults to ~/.claude. Also creates ~/.config/travel-search/config.yaml
 * from config.example.yaml when, and only when, no config exists yet.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(dirname(import.meta.path));
const SKILL_NAME = "TravelSearch";
const SHIP = ["SKILL.md", "README.md", "LICENSE", "package.json", "config.example.yaml", "Tools", "Workflows", "References", "docs", "systemd"];

function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export const VERSION: string = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;

/** Every shipped file as relative path -> contents, so two trees can be compared. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  for (const rel of readdirSync(root, { recursive: true }) as string[]) {
    const p = join(root, rel);
    if (lstatSync(p).isFile()) out.set(rel, readFileSync(p, "latin1"));
  }
  return out;
}

function sameTree(a: string, b: string): boolean {
  const x = snapshot(a);
  const y = snapshot(b);
  if (x.size !== y.size) return false;
  for (const [k, v] of x) if (y.get(k) !== v) return false;
  return true;
}

function installedVersion(dest: string): string | undefined {
  try {
    return readFileSync(join(dest, "VERSION"), "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * Safe to run any number of times. The new copy is built next to the old one and swapped
 * in only when complete, so a failed run leaves the previous install untouched; a run
 * that would change nothing changes nothing and says so.
 */
export function install(opts: { claudeDir: string; configDir: string; link: boolean }): string[] {
  const log: string[] = [];
  const skillsDir = join(opts.claudeDir, "skills");
  const dest = join(skillsDir, SKILL_NAME);
  mkdirSync(skillsDir, { recursive: true });

  let existing: "none" | "link" | "dir" = "none";
  if (lexists(dest)) {
    if (lstatSync(dest).isSymbolicLink()) existing = "link";
    else {
      // Only ever replace a directory that is recognisably an earlier install of this skill.
      const md = join(dest, "SKILL.md");
      if (!existsSync(md) || !/^name:\s*TravelSearch\s*$/m.test(readFileSync(md, "utf8"))) {
        throw new Error(`${dest} exists and is not a TravelSearch install — refusing to overwrite it`);
      }
      existing = "dir";
    }
  }

  if (opts.link) {
    if (existing === "link" && resolve(skillsDir, readlinkSync(dest)) === REPO) {
      log.push(`unchanged ${dest} -> ${REPO} (already linked)`);
    } else {
      if (existing !== "none") rmSync(dest, { recursive: true, force: true });
      symlinkSync(REPO, dest, "dir");
      log.push(`linked   ${dest} -> ${REPO}`);
    }
  } else {
    const stage = join(skillsDir, `.${SKILL_NAME}.installing-${process.pid}`);
    rmSync(stage, { recursive: true, force: true });
    try {
      mkdirSync(stage, { recursive: true });
      for (const item of SHIP) {
        const src = join(REPO, item);
        if (!existsSync(src)) continue;
        cpSync(src, join(stage, item), {
          recursive: true,
          filter: (s) => !/(^|\/)(\.git|node_modules)(\/|$)/.test(s.slice(REPO.length)),
        });
      }
      writeFileSync(join(stage, "VERSION"), `${VERSION}\n`);
      const was = existing === "dir" ? installedVersion(dest) : undefined;
      if (existing === "dir" && sameTree(stage, dest)) {
        rmSync(stage, { recursive: true, force: true });
        log.push(`unchanged ${dest} (${VERSION}, already current)`);
      } else {
        const old = `${stage}.old`;
        if (existing !== "none") renameSync(dest, old);
        try {
          renameSync(stage, dest);
        } catch (e) {
          if (existing !== "none") renameSync(old, dest);
          throw e;
        }
        if (existing !== "none") rmSync(old, { recursive: true, force: true });
        const from = existing === "link" ? " (replaced a symlink)" : was ? ` (was ${was})` : "";
        log.push(`installed ${VERSION} -> ${dest}${from}`);
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }

  const cfg = join(opts.configDir, "config.yaml");
  if (lexists(cfg)) {
    if (!existsSync(cfg)) {
      throw new Error(
        `${cfg} is a symlink to ${readlinkSync(cfg)}, which does not exist — fix or remove the link; not writing through it`,
      );
    }
    log.push(`kept     ${cfg} (already exists, not touched)`);
  } else {
    mkdirSync(opts.configDir, { recursive: true });
    cpSync(join(REPO, "config.example.yaml"), cfg);
    log.push(`created  ${cfg} from config.example.yaml — edit it before your first search`);
  }
  return log;
}

if (import.meta.main) {
  const link = process.argv.includes("--link");
  const claudeDir = process.env.CLAUDE_DIR || join(homedir(), ".claude");
  const configDir = join(homedir(), ".config", "travel-search");
  try {
    for (const l of install({ claudeDir, configDir, link })) console.log(l);
    const tool = join(claudeDir, "skills", SKILL_NAME, "Tools", "travel.ts");
    console.log(`\nnext:\n  1. edit ${join(configDir, "config.yaml")}`);
    console.log(`  2. seats.aero key (optional): put it in ${join(configDir, "seats-aero-key")} and chmod 600`);
    console.log(`  3. bun ${tool} doctor`);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
}
