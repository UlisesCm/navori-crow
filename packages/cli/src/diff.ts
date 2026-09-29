/** Placeholder that replaces every masked value. */
export const MASK = "***";

/** Keys whose value is masked in any diff line (JSON `"k": "v"`, TOML `k = "v"`, `k: v`). */
const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|bearer|credential)/i;

/** Options of {@link maskedDiff}. */
export interface DiffOptions {
  /** Literal secrets (e.g. the ingest token) replaced wherever they appear. */
  secrets?: readonly string[];
  /** Extra keys whose values are masked, e.g. `env` keys crow did not write (D13). */
  maskKeys?: readonly string[];
  /** Header path shown in `---`/`+++`. */
  label?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Multi-line TOML string opener whose key looks secret: `password = """`. */
const MULTILINE_OPEN = /^\s*[\w."'-]+\s*=\s*("""|''')/;

/** Builds the key pattern (secret words plus caller-supplied keys). */
function keyPattern(opts: DiffOptions): string {
  const extra = (opts.maskKeys ?? []).map(escapeRegExp);
  return extra.length > 0 ? `(?:${SECRET_KEY.source}|${extra.join("|")})` : SECRET_KEY.source;
}

/** Masks secret-looking values in one line of config text (single-line forms only). */
export function maskLine(line: string, opts: DiffOptions = {}): string {
  let out = line;
  for (const secret of opts.secrets ?? []) {
    if (secret.length > 0) out = out.split(secret).join(MASK);
  }
  const keys = keyPattern(opts);
  // "key": "value" | key = "value" | key: value; a `Bearer <token>` value is swallowed whole.
  const kv = new RegExp(
    `(["']?[\\w.-]*${keys}[\\w.-]*["']?\\s*[:=]\\s*)(?:Bearer\\s+[^\\s"',]+|"[^"]*"|'[^']*'|[^,\\s}]+)`,
    "gi",
  );
  out = out.replace(kv, `$1"${MASK}"`);
  // Argument arrays: ["--token", "abc"] and unquoted `--token abc` / `--token=abc`.
  const flag = `-{1,2}[\\w-]*${keys}[\\w-]*`;
  out = out.replace(new RegExp(`("${flag}"\\s*,\\s*)"[^"]*"`, "gi"), `$1"${MASK}"`);
  out = out.replace(new RegExp(`(\\s${flag}[=\\s]+)[^\\s"',\\]]+`, "gi"), `$1${MASK}`);
  // `Bearer <value>` inside any string.
  return out.replace(/(Bearer\s+)[^\s"',]+/gi, `$1${MASK}`);
}

/**
 * Masks a whole text line by line, carrying state for multi-line TOML strings
 * (`password = """` … `"""`): their continuation lines are replaced entirely.
 */
export function maskLines(lines: readonly string[], opts: DiffOptions = {}): string[] {
  const keyRe = new RegExp(keyPattern(opts), "i");
  let delim: string | null = null;
  return lines.map((line) => {
    if (delim !== null) {
      if (line.includes(delim)) delim = null;
      return MASK;
    }
    const open = MULTILINE_OPEN.exec(line);
    const d = open?.[1];
    if (d && keyRe.test(line.slice(0, open.index + open[0].length))) {
      const rest = line.slice(open.index + open[0].length);
      if (!rest.includes(d)) {
        delim = d;
        return `${line.slice(0, open.index + open[0].length - d.length)}"${MASK}"`;
      }
    }
    return maskLine(line, opts);
  });
}

/** Line-level edit script via LCS: `[op, index]`, the index into `a` (" ", "-") or `b` ("+"). */
function editScript(a: string[], b: string[]): Array<[" " | "-" | "+", number]> {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const script: Array<[" " | "-" | "+", number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      script.push([" ", i]);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) script.push(["-", i++]);
    else script.push(["+", j++]);
  }
  while (i < n) script.push(["-", i++]);
  while (j < m) script.push(["+", j++]);
  return script;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Unified diff (context 0) of `before` → `after` with secret-looking values masked
 * on both sides (D13). Returns `""` when nothing changes. Lines are compared raw and
 * printed masked; a final pass then removes every known literal secret from the
 * whole output, whatever form it appears in.
 */
export function maskedDiff(before: string, after: string, opts: DiffOptions = {}): string {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const oldMasked = maskLines(oldLines, opts);
  const newMasked = maskLines(newLines, opts);
  const script = editScript(oldLines, newLines);
  const out: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let k = 0;
  while (k < script.length) {
    if (script[k]![0] === " ") {
      oldLine++;
      newLine++;
      k++;
      continue;
    }
    const oldStart = oldLine;
    const newStart = newLine;
    const removed: string[] = [];
    const added: string[] = [];
    while (k < script.length && script[k]![0] !== " ") {
      const [op, idx] = script[k]!;
      if (op === "-") removed.push(oldMasked[idx]!);
      else added.push(newMasked[idx]!);
      k++;
    }
    oldLine += removed.length;
    newLine += added.length;
    const range = (start: number, len: number): string =>
      len === 1 ? `${start}` : `${len === 0 ? start - 1 : start},${len}`;
    out.push(`@@ -${range(oldStart, removed.length)} +${range(newStart, added.length)} @@`);
    for (const line of removed) out.push(`-${line}`);
    for (const line of added) out.push(`+${line}`);
  }
  if (out.length === 0) return "";
  const label = opts.label ?? "config";
  let text = [`--- ${label}`, `+++ ${label}`, ...out].join("\n") + "\n";
  for (const secret of opts.secrets ?? []) {
    if (secret.length > 0) text = text.split(secret).join(MASK);
  }
  return text;
}

/** Indent unit of a JSON text: the first indented line's leading whitespace, default two spaces. */
export function detectIndent(text: string): string {
  const match = /^([ \t]+)\S/m.exec(text);
  return match?.[1] ?? "  ";
}

/**
 * Format-change notice (D13, SF9): re-serializing JSON with the detected indent
 * rewrites lines that have no semantic change. Returns the notice, or `null`
 * when the text is not JSON or the re-serialization is identical.
 */
export function formatChangeNotice(jsonText: string): string | null {
  let reserialized: string;
  try {
    reserialized = JSON.stringify(JSON.parse(jsonText), null, detectIndent(jsonText)) + "\n";
  } catch {
    return null;
  }
  const changed = editScript(splitLines(jsonText), splitLines(reserialized)).filter(
    ([op]) => op === "-",
  ).length;
  return changed === 0 ? null : `${changed} lines change only in format`;
}
