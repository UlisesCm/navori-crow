/**
 * Walks every file under `fixtures/` and fails on PII patterns (risk R2):
 * real home paths, email addresses, common secret shapes, and absolute
 * paths pointing outside the fixture sandbox. Long unallowlisted free text
 * is not asserted here — the anonymizer's marker scheme
 * (`scripts/anonymize/claude.ts`) already replaces it structurally, so a
 * literal-text check would just duplicate that guarantee.
 *
 * Scoping note (review round 2): the request was "any absolute path
 * outside `/tmp/crow-fixture/` fails", but `fixtures/claude/navori-audit/`
 * is a literal copy from navori-harness (predates this repo's anonymizer)
 * whose synthetic `cwd` is `/tmp/fixture-repo` — a different, equally
 * sandboxed `/tmp/…` convention. Per this task's own rule ("if a literal
 * copy legitimately trips a rule, scope the rule, don't edit the
 * fixture"), the check below allows *any* `/tmp/…` path (both
 * conventions) and instead targets the concrete leak vectors: other
 * absolute-path roots that identify a real machine/user.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { IDENTIFIER_KEY_RE } from "../scripts/anonymize/claude";

const FIXTURES_ROOT = import.meta.dir;

const PII_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "/Users/ path", re: /\/Users\// },
  { name: "/home/ path", re: /\/home\// },
  { name: "/root/ path", re: /\/root\// },
  { name: "/Volumes/ path", re: /\/Volumes\// },
  { name: "/Applications/ path", re: /\/Applications\// },
  { name: "Windows user profile path", re: /[A-Za-z]:\\Users\\/ },
  { name: "email address", re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
  { name: "OpenAI-shaped secret key", re: /\bsk-[A-Za-z0-9]{16,}/ },
  { name: "GitHub personal access token", re: /\bghp_[A-Za-z0-9]{20,}/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  // Raw API ids (`toolu_…`, `msg_…`, `req_…`) as a key OR a value. The anonymizer pseudonymises
  // them to `idN`; the raw link to the original `tool_use.id` is unrecoverable by design.
  { name: "raw API id (toolu_/msg_/req_)", re: /\b(?:toolu|msg|req)_[A-Za-z0-9]{6,}/ },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("fixtures hygiene (risk R2)", () => {
  test("no fixture file carries a PII pattern", () => {
    // Covers: risk R2
    const files = walk(FIXTURES_ROOT).filter((f) => f !== import.meta.path);
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const pattern of PII_PATTERNS) {
        if (pattern.re.test(content)) {
          violations.push(`${relative(FIXTURES_ROOT, file)}: ${pattern.name}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("each pattern actually catches its violation, and both /tmp sandboxes stay allowed", () => {
    // Covers: risk R2 (a regex that silently stops matching would make the walk above vacuous)
    const positiveSamples: Record<string, string> = {
      "/Users/ path": "/Users/ulisescm/project",
      "/home/ path": "/home/dev/project",
      "/root/ path": "/root/.bashrc",
      "/Volumes/ path": "/Volumes/external/project",
      "/Applications/ path": "/Applications/Foo.app",
      "Windows user profile path": "C:\\Users\\bob\\project",
      "email address": "person@example.com",
      "OpenAI-shaped secret key": "sk-abcdefghijklmnopqrstuvwx",
      "GitHub personal access token": "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "AWS access key id": "AKIAABCDEFGHIJKLMNOP",
      "raw API id (toolu_/msg_/req_)": "toolu_01CvbLVhVT7pTiHvGuzCfBYe",
    };
    for (const pattern of PII_PATTERNS) {
      const sample = positiveSamples[pattern.name];
      expect(sample).toBeDefined();
      expect(pattern.re.test(sample!)).toBe(true);
    }

    const safeSamples = [
      "/tmp/crow-fixture/navori-crow/id0.jsonl", // this repo's anonymizer's rewrite target
      "/tmp/fixture-repo/sess-aaa11111.jsonl", // navori-audit's literal-copy convention
      "https://example.test/pull/42", // a URL path is not a leaked filesystem path
    ];
    for (const safe of safeSamples) {
      expect(PII_PATTERNS.some((p) => p.re.test(safe))).toBe(false);
    }
  });
});

/**
 * Structural contract check (round 3): a substring-pattern grep, however broad, can never enumerate
 * every possible free-text leak — round 2's `SUSPICIOUS_KEY_RE`/PII-pattern approach missed
 * sentence-shaped and model-id-shaped object *keys* entirely (`AskUserQuestion`'s `answers` map,
 * `modelUsage`'s map). This instead verifies the anonymizer's *output contract* directly: every key
 * must be identifier-shaped or a key marker, and every string leaf must be a value marker, a
 * pseudonymised id, an ISO timestamp, the fixture's rewritten `cwd`, or (simplification, per the
 * task) a short (<=64 char) whitespace-free token — the shape every allowlisted structural enum
 * (`"user"`, `"tool_use"`, `"claude-opus-5"`, …) always has, and the shape free text essentially
 * never has.
 */
const KEY_MARKER_RE = /^«key:\d+»$/;
const STR_MARKER_RE = /^«str:\d+»$/;
const PSEUDONYM_ID_RE = /^id\d+$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIXTURE_CWD_PREFIX = "/tmp/crow-fixture/";
const MAX_UNMARKED_STRING_LEN = 64;
/**
 * `anonymizeTaskNotificationContent`'s reconstructed output (`scripts/anonymize/claude.ts`) — the one
 * string the anonymizer deliberately rebuilds instead of markering, because `map-line.ts`/
 * `mapAttachment` need the `<tool-use-id>` pseudonym and `<status>` value readable (round 2/3,
 * `.claude/progress/impl_f1-b4t3-contract.md`). A **strict full-match** on exactly that shape: no
 * extra tag, no trailing text — anything else (a leaked `<summary>`/`<result>`, or any other XML
 * wrapper) still falls through to the default marker/short-token rule below and gets flagged.
 */
const TASK_NOTIFICATION_RE =
  /^<task-notification><tool-use-id>id\d+<\/tool-use-id><status>[a-z_]+<\/status><\/task-notification>$/;

function isAcceptableKey(key: string): boolean {
  return IDENTIFIER_KEY_RE.test(key) || KEY_MARKER_RE.test(key);
}

function isAcceptableValue(value: string): boolean {
  if (STR_MARKER_RE.test(value)) return true;
  if (PSEUDONYM_ID_RE.test(value)) return true;
  if (ISO_TIMESTAMP_RE.test(value)) return true;
  if (value.startsWith(FIXTURE_CWD_PREFIX)) return true;
  if (TASK_NOTIFICATION_RE.test(value)) return true;
  return value.length <= MAX_UNMARKED_STRING_LEN && !/\s/.test(value);
}

/** Recursively checks every key and string leaf of a parsed JSON node against the contract above. */
function collectStructuralViolations(node: unknown, label: string): string[] {
  const violations: string[] = [];
  if (typeof node === "string") {
    if (!isAcceptableValue(node)) {
      violations.push(`${label}: unmarked free-text value (${JSON.stringify(node.slice(0, 40))})`);
    }
    return violations;
  }
  if (Array.isArray(node)) {
    node.forEach((el, i) => violations.push(...collectStructuralViolations(el, `${label}[${i}]`)));
    return violations;
  }
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (!isAcceptableKey(k)) violations.push(`${label}.${k}: non-identifier, unmarkered key`);
      violations.push(...collectStructuralViolations(v, `${label}.${k}`));
    }
  }
  return violations;
}

/** Every `.jsonl`/`.json` file under `fixtures/claude/cc-*`, `fixtures/claude/hooks`, `fixtures/otlp/{claude,codex}`
 * and `fixtures/codex/*` (rollouts, `codex/hooks`, the `codex/<version>` sessions) — the anonymized real fixtures, never `fixtures/claude/navori-audit/` (a
 * pre-anonymizer literal copy, out of scope). The B0 dirs (hooks, OTLP) also get the stricter
 * allowlist check in `fixtures/b0-claude.test.ts` / `fixtures/b0-codex.test.ts`. */
function anonymizedFixtureFiles(): string[] {
  const out: string[] = [];
  const claudeDir = join(FIXTURES_ROOT, "claude");
  if (existsSync(claudeDir)) {
    for (const entry of readdirSync(claudeDir)) {
      if (!entry.startsWith("cc-") && entry !== "hooks") continue;
      const full = join(claudeDir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
    }
  }
  for (const engine of ["claude", "codex"]) {
    const otlpDir = join(FIXTURES_ROOT, "otlp", engine);
    if (existsSync(otlpDir)) out.push(...walk(otlpDir));
  }
  const codexDir = join(FIXTURES_ROOT, "codex");
  if (existsSync(codexDir)) {
    for (const entry of readdirSync(codexDir)) {
      const full = join(codexDir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
    }
  }
  return out.filter((f) => f.endsWith(".jsonl") || f.endsWith(".json"));
}

describe("fixtures hygiene (risk R2): structural contract on anonymized fixtures", () => {
  test("cc-*/ and codex/* fixtures only carry markers/pseudonyms/timestamps/the fixture cwd/short enums", () => {
    // Covers: risk R2. Walks `fixtures/claude/cc-*/` and every `fixtures/codex/<version>/` rollout.
    const files = anonymizedFixtureFiles();
    expect(files.some((f) => f.includes(`${join("fixtures", "codex")}/`))).toBe(true); // not vacuous
    for (const dir of [
      join("claude", "hooks"),
      join("otlp", "claude"),
      join("codex", "hooks"),
      join("otlp", "codex"),
    ]) {
      expect(files.some((f) => f.includes(`${dir}/`))).toBe(true); // B0 dirs are covered too
    }
    const violations: string[] = [];
    for (const file of files) {
      const label = relative(FIXTURES_ROOT, file);
      const content = readFileSync(file, "utf8");
      if (file.endsWith(".jsonl")) {
        content.split("\n").forEach((rawLine, i) => {
          if (rawLine.trim() === "") return;
          violations.push(...collectStructuralViolations(JSON.parse(rawLine), `${label}:${i + 1}`));
        });
      } else {
        violations.push(...collectStructuralViolations(JSON.parse(content), label));
      }
    }
    expect(violations).toEqual([]);
  });

  test("the structural checker catches a synthetic key/value leak and accepts a well-formed anonymized shape", () => {
    // Covers: risk R2 — proves the check above isn't vacuous by construction, independent of
    // whether `cc-*/`/`codex/*` fixtures exist yet.
    const leaked = {
      sessionId: "id0",
      timestamp: "2026-01-01T00:00:00.000Z",
      toolUseResult: {
        answers: {
          "R15 — ¿Cómo se asigna el proyecto cuando el cwd no resuelve a un repo git?":
            "unresolved",
        },
        modelUsage: { "claude-opus-5-5[1m]": { inputTokens: 10 } },
      },
    };
    expect(collectStructuralViolations(leaked, "synthetic")).not.toEqual([]);

    const clean = {
      sessionId: "id0",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp/crow-fixture/navori-crow",
      type: "user",
      message: { id: "id1", content: "«str:0»" },
      toolUseResult: { "«key:0»": "«str:1»" },
    };
    expect(collectStructuralViolations(clean, "synthetic")).toEqual([]);
  });

  test("the reconstructed task-notification shape is allowed only as an exact full match", () => {
    // Covers: risk R2 — a strict, not a prefix/substring, match: any extra tag or trailing text
    // (e.g. a leaked `<summary>`) must still be flagged, not waved through because it merely
    // *starts with* the allowed shape.
    const exact = {
      type: "attachment",
      attachment: {
        prompt:
          "<task-notification><tool-use-id>id42</tool-use-id><status>completed</status></task-notification>",
      },
    };
    expect(collectStructuralViolations(exact, "synthetic")).toEqual([]);

    const withLeakedSummary = {
      type: "attachment",
      attachment: {
        prompt:
          "<task-notification><tool-use-id>id42</tool-use-id><status>completed</status>" +
          "<summary>SENTINEL_leak</summary></task-notification>",
      },
    };
    // Violation labels truncate the value to 40 chars (so the checker's own failure output can't
    // leak PII) — assert the flag fires, not that the sentinel appears in the label text.
    expect(collectStructuralViolations(withLeakedSummary, "synthetic")).not.toEqual([]);
  });
});
