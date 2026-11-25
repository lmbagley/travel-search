/**
 * secrets.ts — resolve an API key at call time from a reference, never from a literal.
 *
 * Reference forms (all live in config; the VALUE never does):
 *   env:NAME          read environment variable NAME
 *   op://vault/item/field   read via the 1Password CLI (`op read`)
 *   ~/path or /path   read a file (trimmed); warns when group/other can read it
 *
 * The value is held in memory only. It is never logged, never returned inside an
 * error, and `redact()` scrubs it from any text that might echo it back.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { expandHome } from "./config.ts";

export interface ResolvedSecret {
  value: string;
  /** Where it came from, safe to print: "env:SEATS_AERO_API_KEY", "file:~/...", "op://..." */
  via: string;
  warning?: string;
}

export class SecretError extends Error {}

export async function resolveSecret(ref: string): Promise<ResolvedSecret> {
  const r = ref.trim();
  if (r.startsWith("env:")) {
    const name = r.slice(4);
    const v = process.env[name]?.trim();
    if (!v) throw new SecretError(`environment variable ${name} is not set`);
    return { value: v, via: `env:${name}` };
  }
  if (r.startsWith("op://")) {
    let proc;
    try {
      proc = Bun.spawn(["op", "read", r], { stdout: "pipe", stderr: "pipe" });
    } catch {
      throw new SecretError(`1Password CLI (op) is not installed or not on PATH; cannot read ${r}`);
    }
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const rc = await proc.exited;
    if (rc !== 0) throw new SecretError(`op read ${r} failed (exit ${rc}): ${err.trim().slice(0, 200)}`);
    const v = out.trim();
    if (!v) throw new SecretError(`op read ${r} returned an empty value`);
    return { value: v, via: r };
  }
  const path = expandHome(r.startsWith("file:") ? r.slice(5) : r);
  if (!existsSync(path)) throw new SecretError(`no key file at ${path}`);
  const v = readFileSync(path, "utf8").trim();
  if (!v) throw new SecretError(`key file ${path} is empty`);
  const mode = statSync(path).mode & 0o777;
  const warning =
    (mode & 0o077) !== 0 ? `${path} is mode ${mode.toString(8).padStart(3, "0")}; run chmod 600 on it` : undefined;
  return { value: v, via: `file:${r.replace(/^file:/, "")}`, ...(warning ? { warning } : {}) };
}

/** Replace every occurrence of `secret` in `text`. Short secrets are not redacted (too many false hits). */
export function redact(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 6) return text;
  return text.split(secret).join("<REDACTED>");
}
