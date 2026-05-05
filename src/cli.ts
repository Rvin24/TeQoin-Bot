/**
 * Tiny argv parser tailored to our CLI shape.
 *
 * Supports:
 *   <command> [--flag value] [--flag=value] [--bool]
 *
 * Unknown commands and unknown flags are surfaced as errors so typos
 * don't silently no-op.
 */

export type Argv = ReadonlyArray<string>;

export interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positional: readonly string[];
}

const KNOWN_BOOL_FLAGS = new Set(["yes", "y", "help", "h"]);

export function parseArgs(argv: Argv): ParsedArgs {
  if (argv.length === 0) {
    return { command: "", flags: {}, positional: [] };
  }
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx !== -1) {
        const key = token.slice(2, eqIdx);
        const value = token.slice(eqIdx + 1);
        flags[key] = value;
        continue;
      }
      const key = token.slice(2);
      const next = rest[i + 1];
      if (KNOWN_BOOL_FLAGS.has(key) || next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else if (token.startsWith("-") && token.length > 1) {
      const key = token.slice(1);
      flags[key] = true;
    } else {
      positional.push(token);
    }
  }

  return { command: command ?? "", flags, positional };
}

export function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true;
}
