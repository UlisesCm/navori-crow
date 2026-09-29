/** Inputs of the generated `crow-ingest-hook` script (D14). */
export interface HookScriptOptions {
  /** `$CROW_HOME`; the token is read from `<crowHome>/token` at run time, never embedded. */
  crowHome: string;
  /** crow HTTP port, baked into the script. */
  port: number;
}

/** Single-quotes a value for POSIX sh. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Generates the fail-open hook script (D14, R20): reads the hook JSON from
 * stdin and POSTs it to `/ingest/hook/<engine>` with a 2 s cap. Whatever
 * happens (crow down, hung, 401, 413, no `curl`), it exits 0 and prints nothing.
 * The whole attempt sits inside one redirected group so even the shell's own
 * "command not found" goes to /dev/null.
 */
export function generateHookScript(opts: HookScriptOptions): string {
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error(`invalid port: ${opts.port}`);
  }
  return `#!/bin/sh
# Installed by crow. Fail-open: always exits 0, never writes to stdout.
case "$1" in
  claude|codex) ;;
  *) exit 0 ;;
esac
{
  TOKEN=$(cat ${shQuote(`${opts.crowHome}/token`)} 2>/dev/null | tr -d '\\r\\n')
  URL="http://127.0.0.1:${opts.port}/ingest/hook/$1"
  HF=""
  trap 'rm -f "$HF" >/dev/null 2>&1' EXIT
  trap 'exit 0' HUP INT TERM
  if [ -n "$TOKEN" ]; then
    # The token goes through a 0600 header file (-H @file), never through argv (ps).
    HF=$(umask 077; mktemp "\${TMPDIR:-/tmp}/crow-hook.XXXXXX")
  fi
  if [ -n "$TOKEN" ] && [ -n "$HF" ]; then
    printf 'Authorization: Bearer %s\\n' "$TOKEN" > "$HF"
    curl -s -m 2 -X POST -H 'Content-Type: application/json' -H "@$HF" --data-binary @- "$URL"
  else
    curl -s -m 2 -X POST -H 'Content-Type: application/json' --data-binary @- "$URL"
  fi
} >/dev/null 2>&1 || true
exit 0
`;
}
