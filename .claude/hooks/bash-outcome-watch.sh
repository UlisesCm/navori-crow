# navori:managed start id="bash-outcome-watch-base" hash="007186ff" version="0.11.1" source="@navori/core"
#!/usr/bin/env bash
# PostToolUseFailure(Bash) advisory. The shared state helper also handles reset
# from routing-watch on a successful PostToolUse(Bash).
set -uo pipefail
# Shared hook boilerplate — inlined into each hook at render time (see the
# include directive in the source scripts + lib/render/hook-includes.ts). Single source
# of truth for the sibling gate scripts; DO NOT copy this body back into a hook
# by hand (that is the drift #225/#261 removed).
#
# PreToolUse(Bash) passes the tool input on stdin. Read one field out of it
# WITHOUT hard-depending on jq (NOT preinstalled on macOS): try jq, then node
# (Claude Code's own runtime), then a best-effort sed unwrap on the leaf key.
# Nothing extracted → empty output, and each caller decides what that means (the
# gate scripts scan defensively; guard-destructive waves the command through).
#
# $1 is a dotted path written HERE, never user input — the payload is the data.
# Generic on purpose: `.cwd` feeds the worktree resolver of #454 through the
# SAME hardened cascade instead of a second copy of it.
#
# The sed fallback reads a JSON string through its first unescaped quote. JSON
# object member order is not a host contract: `command` can precede `cwd`, so a
# greedy capture to the last quote would swallow the rest of the payload when
# neither jq nor node is available.
# `${payload-$(cat)}` (unset test, not `:-`) rather than an unconditional
# `payload=$(cat)`: a caller that already captured stdin itself (spec 0035 —
# `managed-drift-watch.sh` needs the audit recorder's session_id/cwd even on
# tool names this hook does not otherwise read) keeps that value, empty or
# not, instead of this partial re-reading an already-drained pipe and
# clobbering it with "".
payload=${payload-$(cat)}
payload_field() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$payload" | jq -r ".$1 // empty" 2>/dev/null && return 0
  fi
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$payload" | node -e 'let s="";const p=process.argv[1].split(".");process.stdin.on("data",c=>s+=c).on("end",()=>{try{let v=JSON.parse(s);for(const k of p)v=v?.[k];process.stdout.write(String(v??""))}catch{}})' "$1" 2>/dev/null && return 0
  fi
  printf '%s' "$payload" | sed -nE "s/.*\"${1##*.}\"[[:space:]]*:[[:space:]]*\"(([^\"\\]|\\.)*)\".*/\\1/p"
}
extract_cmd() {
  payload_field tool_input.command
}
# NOT called here on purpose. `payload_field` may spawn a process, and
# `routing-watch.sh` — which includes this partial and runs after EVERY tool call
# in every session — never reads `cmd`. Each consumer that wants it calls
# `extract_cmd` itself, at the point where it already knows it needs it.
# Spec 0035 D2 — the single payload adapter shared by every hook that needs an
# engine-specific value. Inlined into each hook at render time (see the
# include directive in the source scripts + lib/render/hook-includes.ts).
# Single source of truth for the Claude/Codex normalization; DO NOT copy this
# body back into a hook by hand or branch on the engine inside a hook — D2
# rejected per-script `if codex …` branches (12 copies of the same logic,
# each one a place to drift).
#
# `nv_engine` is decided by WHERE THE HOOK SCRIPT LIVES ON DISK, not by the
# payload's shape (a `turn_id`/`apply_patch` sniff breaks the day Claude ships
# a field with the same name — see design.md's "Descartado") and not by an
# env var prefix on the registered command (that would change the `command`
# string Codex hashes for `trusted_hash`, un-approving every hook a repo
# already trusted — see hook-registrations.ts's module doc). The registered
# command is always `bash ".../.codex/hooks/<script>.sh"` or
# `bash "$CLAUDE_PROJECT_DIR/.claude/hooks/<script>.sh"`. `$0` — not
# `BASH_SOURCE`, which zsh (#391: hooks run under bash AND zsh) leaves unset
# under `set -u` — is the path the invoking shell was given, and
# `comment-draft-confirm.sh` already established this exact pattern.
#
# Depends on `payload`/`payload_field` (the `extract-cmd` partial): include
# `extract-cmd` in the same script whenever this partial's helpers are used —
# `payload_field` is only CALLED here (inside functions), never at top level,
# so include order between the two partials does not matter.
case "$0" in
  *".codex/hooks/"*) nv_engine=codex ;;
  *) nv_engine=claude ;;
esac

if [ "$nv_engine" = codex ]; then
  nv_cwd=$(payload_field cwd)
  # `cwd` is the session's working dir, which may be a workspace subdir in a
  # monorepo; the project root is always the git toplevel from there. Falls
  # back to the raw cwd outside a git work tree rather than failing closed.
  nv_project_dir=$(git -C "${nv_cwd:-.}" rev-parse --show-toplevel 2>/dev/null) || nv_project_dir=${nv_cwd:-.}
else
  nv_project_dir=${CLAUDE_PROJECT_DIR:-}
fi

# Runtime handoffs have one engine-neutral home. The caller composes this
# relative path with its checkout root; legacy roots remain readable only.
nv_progress_dir=".navori/state/handoffs"

# The Claude-equivalent tool name for the CURRENT PreToolUse/PostToolUse
# payload (D2: apply_patch -> Edit, spawn_agent -> Agent, everything else
# unchanged — `mcp__…` names and `Bash` already match on both engines).
nv_tool() {
  local raw
  raw=$(payload_field tool_name)
  if [ "$nv_engine" = codex ]; then
    case "$raw" in
      apply_patch) printf 'Edit' ;;
      spawn_agent) printf 'Agent' ;;
      *) printf '%s' "$raw" ;;
    esac
  else
    printf '%s' "$raw"
  fi
}

# Paths the current tool call touches, one per line (possibly none). Claude
# carries them as `tool_input.file_path` / `tool_input.notebook_path`; Codex's
# `apply_patch` has no such field — the whole patch is `tool_input.command`,
# and the paths live in its `*** Add File:` / `*** Update File:` /
# `*** Delete File:` / `*** Move to:` headers (codex-rs's apply_patch parser).
nv_edited_paths() {
  if [ "$nv_engine" = codex ]; then
    payload_field tool_input.command | sed -nE \
      's/^\*\*\* (Add File|Update File|Delete File|Move to): (.*)$/\2/p'
  else
    local fp nb
    fp=$(payload_field tool_input.file_path)
    nb=$(payload_field tool_input.notebook_path)
    [ -n "$fp" ] && printf '%s\n' "$fp"
    [ -n "$nb" ] && printf '%s\n' "$nb"
  fi
}

# The subagent type of the current call. Claude: `tool_input.subagent_type`
# (PreToolUse Agent/Task). Codex: `tool_input.agent_type` in PreToolUse
# (spawn_agent), or the top-level `agent_type` Codex adds to SubagentStop.
nv_subagent_type() {
  if [ "$nv_engine" = codex ]; then
    local t
    t=$(payload_field tool_input.agent_type)
    [ -n "$t" ] || t=$(payload_field agent_type)
    printf '%s' "$t"
  else
    payload_field tool_input.subagent_type
  fi
}

# Deliberately NO `nv_emit_context` helper here. `hook-output-contract.test.ts`
# ("los partials no hablan con el host, solo escriben al log") holds every
# `_partials/*.sh` file to zero host-output vocabulary — a partial is inlined
# BEFORE the per-script, per-event output contract is known, so it must never
# construct `hookSpecificOutput`/`systemMessage` itself. Every hook this spec
# touches already builds its own JSON at its own call site (unchanged by D2);
# a script whose Claude/Codex registrations differ in event name (D1: e.g.
# `subagent-stop-handoff` is PostToolUse under Claude, SubagentStop under
# Codex) is unaffected in practice — Codex does not honor `additionalContext`
# on `SubagentStop` at all (codex-research.md), so `systemMessage` is what a
# human sees there regardless of which literal `hookEventName` the JSON claims.
# Shared Bash-outcome helpers (spec 0039 R6/R7, carry-over 0038 D1) — inlined at
# render time. Defines functions only: nothing runs on include, so a hook that
# carries this partial pays parse time and no process.
#
# Depends on `payload`/`payload_field` (`extract-cmd`) and `nv_project_dir` /
# `nv_progress_dir` (`hook-input`); include both in the same script.
#
# THE SUCCESS LANE. The host runs a criterion's `command` in its own Bash tool;
# `PostToolUse` fires only on success, so this lane's very firing is the success
# signal. It appends ONE line per matching pending criterion to
# `<state dir>/workplan_<feature>.evidence.jsonl`, which `plan update` compares
# against the criterion and the current tree (`lib/plan/evidence.ts`). It never
# runs the criterion's command and never writes anything but that line.
#
# FAIL-OPEN, NO PARTIAL LINE. Every path returns 0. The line is built entirely in
# memory and written by a single `printf >>` as the LAST step, so a kill at any
# earlier point (the tree fingerprint is the slow part) leaves no line at all and
# `plan update` rejects with "no run recorded".
#
# FAST PATH, BUILTINS ONLY. `acceptance-index` (rewritten by the CLI) holds
# `<command JSON-escaped>\t<feature>\t<A<n>>\t<state dir>` per pending
# criterion. The command is matched as the EXACT JSON string value of
# `"command"` in the raw payload — no decoding, no normalization, no process.
# A `tool_response` cannot forge a match: inside it every quote is `\"`.

# Git with the repo-controlled code paths neutralized (invariant 9): fsmonitor is
# a command git runs on index refresh, hooksPath redirects hooks. Same flags as
# `GIT_HARDENING` in `lib/plan/evidence.ts`.
navori_git() {
  git -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"
}

# Content hash of the whole working tree — the SAME procedure as
# `fingerprintTree` in `lib/plan/evidence.ts`, which `plan update` re-runs to
# compare (change one, change both): no `git add` (filters/fsmonitor), blobs by
# `hash-object --no-filters`, a scratch index, `write-tree`. Prints the tree hash
# or returns 1. Exec bit is `[ -x ]` where the TypeScript side tests
# `mode & 0o111`; they differ only for a file executable by group/other but not
# by its owner, which then fails safe (plan update asks for a rerun).
navori_tree_fingerprint() {
  (
    cd "$1" 2>/dev/null || exit 1
    scratch=$(navori_git rev-parse --path-format=absolute --git-path navori-fp-index 2>/dev/null) || exit 1
    [ -n "$scratch" ] || exit 1
    [ ! -e "$scratch.lock" ] || exit 1
    work=$(mktemp -d "${TMPDIR:-/tmp}/navori-fp.XXXXXX" 2>/dev/null) || exit 1
    trap 'rm -f "$work"/list "$work"/files "$work"/links "$work"/paths "$work"/shas; rmdir "$work" 2>/dev/null' EXIT
    navori_git ls-files -z --cached --others --exclude-standard --deduplicate -- . \
      ':(exclude).navori/state' ':(exclude).claude/progress' ':(exclude).codex/progress' \
      ':(exclude).claude/worktrees' > "$work/list" 2>/dev/null || exit 1
    : > "$work/links"
    while IFS= read -r -d '' p; do
      case "$p" in *$'\n'*) exit 1 ;; esac
      if [ -L "$p" ]; then
        target=$(readlink "./$p") || exit 1
        sha=$(printf '%s' "$target" | navori_git hash-object -w --no-filters --stdin 2>/dev/null) || exit 1
        [ -n "$sha" ] || exit 1
        printf '120000 %s\t%s\n' "$sha" "$p" >&3
      elif [ -f "$p" ]; then
        if [ -x "$p" ]; then mode=100755; else mode=100644; fi
        printf '%s\t%s\n' "$mode" "$p"
      fi
    done < "$work/list" > "$work/files" 3>> "$work/links"
    if [ -s "$work/files" ]; then
      cut -f2- "$work/files" > "$work/paths"
      navori_git hash-object -w --no-filters --stdin-paths < "$work/paths" > "$work/shas" 2>/dev/null || exit 1
      [ "$(wc -l < "$work/paths" | tr -d ' ')" = "$(wc -l < "$work/shas" | tr -d ' ')" ] || exit 1
      awk -F'\t' 'NR==FNR { m[FNR]=$1; p[FNR]=substr($0, index($0, "\t")+1); next } { printf "%s %s\t%s\n", m[FNR], $0, p[FNR] }' \
        "$work/files" "$work/shas" >> "$work/links" || exit 1
    fi
    export GIT_INDEX_FILE=$scratch
    navori_git read-tree --empty >/dev/null 2>&1 || exit 1
    if [ -s "$work/links" ]; then
      tr '\n' '\0' < "$work/links" | navori_git update-index --add -z --index-info >/dev/null 2>&1 || exit 1
    fi
    navori_git write-tree 2>/dev/null
  )
}

# Escapes backslash and double quote for a JSON string value; prints it.
navori_json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s"
}

# Repeat-failure state is shared by the PostToolUseFailure watcher and the
# existing success lane. A successful Bash call only pays for Node when its
# session already has a failure-state file; ordinary calls use builtins only.
navori_bash_failure_state() {
  local action=$1 sid=${CLAUDE_CODE_SESSION_ID:-} dir file
  case "$sid" in "" | *[!A-Za-z0-9._-]*) return 0 ;; esac
  [ -n "${nv_project_dir:-}" ] || return 0
  dir=$nv_project_dir/.navori/state/hooks/bash-outcome-watch
  file=$dir/$sid
  if [ "$action" = reset ]; then
    [ -f "$file" ] && [ ! -L "$file" ] || return 0
  fi
  command -v node >/dev/null 2>&1 || return 0
  NV_BASH_OUTCOME_ACTION=$action NV_BASH_OUTCOME_DIR=$dir NV_BASH_OUTCOME_FILE=$file \
    NV_BASH_OUTCOME_ROOT=$nv_project_dir node -e '
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const env = process.env;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input);
    if (payload.tool_name !== "Bash" || payload.session_id !== env.CLAUDE_CODE_SESSION_ID) return;
    if (payload.is_interrupt === true || payload.tool_response?.is_interrupt === true) return;
    const command = payload.tool_input?.command;
    const cwd = payload.cwd;
    if (typeof command !== "string" || !command.trim() || typeof cwd !== "string" || !cwd) return;
    const agent = typeof payload.agent_id === "string" ? payload.agent_id : "";
    const key = digest(JSON.stringify([command.trim().replace(/\s+/g, " "), cwd, agent]));
    const root = path.resolve(env.NV_BASH_OUTCOME_ROOT);
    const dir = env.NV_BASH_OUTCOME_DIR;
    const file = env.NV_BASH_OUTCOME_FILE;
    if (dir !== path.join(root, ".navori/state/hooks/bash-outcome-watch")) return;
    for (const component of [root, path.join(root, ".navori"), path.join(root, ".navori/state"), path.join(root, ".navori/state/hooks"), dir]) {
      if (fs.existsSync(component)) {
        if (!fs.lstatSync(component).isDirectory() || fs.lstatSync(component).isSymbolicLink()) return;
      } else if (env.NV_BASH_OUTCOME_ACTION === "failure") {
        fs.mkdirSync(component);
      } else return;
    }
    if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) return;
    let rows = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    if (!Array.isArray(rows) || rows.some((row) => typeof row.key !== "string" || typeof row.sig !== "string" || typeof row.count !== "number" || typeof row.epoch !== "number")) return;
    if (env.NV_BASH_OUTCOME_ACTION === "reset") {
      const next = rows.filter((row) => row.key !== key);
      if (next.length === rows.length) return;
      rows = next;
    } else {
      const error = payload.error;
      if (typeof error !== "string") return;
      const match = /exit code\s+(\d+)/i.exec(error);
      if (!match) return;
      const code = match[1];
      const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const home = env.HOME ? env.HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null;
      const body = error.replace(/^.*exit code\s+\d+.*\r?\n?/im, "")
        .replace(/\x1b\[[0-9;]*m/g, "")
        .replace(new RegExp(escapedRoot, "g"), "<root>")
        .replace(home ? new RegExp(home, "g") : /\b(?!x)x\b/g, "~")
        .replace(/(?:\/tmp|\/private\/tmp|\/var\/folders)\/[^\s:]+/g, "<tmp>")
        .replace(/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?Z?\b/g, "<t>")
        .replace(/\b\d\d:\d\d:\d\d(?:\.\d+)?\b/g, "<t>")
        .replace(/\b\d+(?:\.\d+)?\s?(?:ms|seconds?|minutes?)\b/gi, "<d>")
        .replace(/\b[0-9a-f]{8,}\b/gi, "<h>")
        .split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 20).join("\n");
      if (!body) return;
      const sig = digest(code + "\n" + body);
      const previous = rows.find((row) => row.key === key);
      const count = previous?.sig === sig ? Math.min(previous.count + 1, 3) : 1;
      const notified = previous?.sig === sig && previous.notified === true;
      rows = rows.filter((row) => row.key !== key);
      rows.push({ key, sig, count, notified: notified || count === 3, epoch: Date.now() });
      if (count === 3 && !notified) {
        const first = body.split("\n")[0].slice(0, 100);
        const note = `navori: el comando ${command.trim().slice(0, 100)} falló 3 veces con la misma firma (exit ${code}: ${first}). Cambia de enfoque con debug-failure o escala al usuario. Si el rojo es intencional, ignora esta nota.`;
        var output = note.slice(0, 400);
      }
    }
    rows.sort((a, b) => b.epoch - a.epoch);
    rows = rows.slice(0, 50);
    const temp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(temp, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
    if (output) process.stdout.write(output + "\n");
  } catch { /* advisory: never change the tool result */ }
});
' <<< "$payload" 2>/dev/null || true
  return 0
}

# Called by `routing-watch.sh` once it knows the tool is `Bash`, and only under
# `claude-post-tool-use` (Codex fires PostToolUse on failure too, so no signal).
navori_bash_success_lane() {
  local idx=$nv_project_dir/$nv_progress_dir/acceptance-index
  [ -s "$idx" ] || return 0
  # A backgrounded call "succeeds" when it LAUNCHES, not when it finishes; an
  # interrupted one did not complete.
  case "$payload" in
    *'"run_in_background":true'* | *'"interrupted":true'*) return 0 ;;
  esac
  local c f i d hits=
  while IFS=$'\t' read -r c f i d; do
    [ -n "$c" ] || continue
    case "$payload" in
      *'"command":"'"$c"'"'[,}]*) hits="$hits$c"$'\t'"$f"$'\t'"$i"$'\t'"$d"$'\n' ;;
    esac
  done < "$idx"
  [ -n "$hits" ] || return 0

  # Slow path: exactly one criterion command ran. Everything is computed first,
  # the write is last.
  local cwd tree head wt htree dirty sid agent ts root
  cwd=$(payload_field cwd)
  [ -n "$cwd" ] || return 0
  tree=$(navori_git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || return 0
  case "$cwd$tree" in *[[:cntrl:]]*) return 0 ;; esac
  head=$(navori_git -C "$tree" rev-parse HEAD 2>/dev/null) || head=
  wt=$(navori_tree_fingerprint "$tree") || return 0
  [ -n "$wt" ] || return 0
  htree=$(navori_git -C "$tree" rev-parse 'HEAD^{tree}' 2>/dev/null) || htree=
  dirty=true
  [ "$wt" = "$htree" ] && dirty=false
  sid=$(payload_field session_id | tr -cd 'A-Za-z0-9._-')
  agent=$(payload_field agent_id | tr -cd 'A-Za-z0-9._-')
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  root=$(pwd -P 2>/dev/null) || root=$nv_project_dir

  local line extra file
  while IFS=$'\t' read -r c f i d; do
    [ -n "$f" ] || continue
    # The index is CLI-written state, but the hook is the one that opens a path
    # taken from it: slug and id shapes, an absolute directory inside this
    # project, no symlinks.
    case "$f" in *[!a-z0-9._-]* | [!a-z0-9]*) continue ;; esac
    case "$i" in
      A[0-9]*) case "${i#A}" in *[!0-9]*) continue ;; esac ;;
      *) continue ;;
    esac
    case "$d" in "$root"/* | "$nv_project_dir"/*) ;; *) continue ;; esac
    case "$d" in *[[:cntrl:]]* | */../* | */..) continue ;; esac
    [ -d "$d" ] && [ ! -L "$d" ] || continue
    file=$d/workplan_$f.evidence.jsonl
    [ ! -L "$file" ] || continue
    # `$c` is already JSON-escaped: it is the index's own field.
    extra=
    [ -z "$sid" ] || extra=$extra',"sessionId":"'$sid'"'
    [ -z "$agent" ] || extra=$extra',"agentId":"'$agent'"'
    line='{"ts":"'$ts'","feature":"'$f'","id":"'$i'","command":"'$c'","tree":"'$(navori_json_str "$tree")'","cwd":"'$(navori_json_str "$cwd")'","head":"'$head'","worktreeTree":"'$wt'","dirty":'$dirty$extra'}'
    printf '%s\n' "$line" >> "$file" 2>/dev/null || true
  done <<NAVORI_HITS
$hits
NAVORI_HITS
  return 0
}
navori_audit_name="bash-outcome-watch"
navori_audit_phase="PostToolUseFailure"
navori_audit_begin() { :; }
navori_audit_log() { :; }
# Shared audit repository resolver (#764) — inlined into every audit hook at
# render time. A nested agent worktree lives below the repository's
# `.claude/worktrees/` directory, but its basename is an ephemeral agent id.
#
# navori_audit_repo_from_cwd <cwd> — prints the stable parent repo name.
# This only uses shell builtins before the existing `basename` call: audit hooks
# run often, so discovering the Git common directory would add an avoidable fork
# per invocation.
navori_audit_repo_from_cwd() {
  navori_audit_repo_cwd=$1
  case "$navori_audit_repo_cwd" in
    */.claude/worktrees | */.claude/worktrees/*)
      navori_audit_repo_cwd=${navori_audit_repo_cwd%%/.claude/worktrees*}
      ;;
  esac
  basename "$navori_audit_repo_cwd" 2>/dev/null
}
# Shared audit-mode event recorder — inlined into each managed hook at render
# time (see the include directive in the source scripts + lib/render/hook-includes.ts).
#
# WHY (spec 0013): a hook is only visible to the transcript when it BLOCKS or
# INJECTS context. Every hook that runs and lets the action through is invisible,
# so `navori audit` could never answer "did the gate run, and what did it cost?".
# The transcript cannot be fixed — it is the host's format — so the harness
# records its own execution instead, and the session log becomes the source of
# truth for what the harness did.
#
# Expects `$payload` (the raw hook payload on stdin) to be in scope, and reads
# `$navori_audit_t0` for the start instant. Both are set by `navori_audit_begin`.
#
# Every variable read here carries a `:-` default ON PURPOSE: most managed hooks
# run under `set -euo pipefail`, where an unset variable ABORTS the hook. A
# recorder that can abort the thing it observes is worse than no recorder, so the
# partial must be safe to inline into `set -u` and `set +e` alike.
#
# FAIL-OPEN ABSOLUTE, and this matters more here than anywhere else: this code is
# inlined into hooks whose own contract is to never break a session. Observation
# must never become the reason an action fails, so every path returns 0 and
# nothing is ever written to stdout — a stray byte there would be interpreted by
# the host as hook output (context injection, or a block reason).

# Start the clock — but only after establishing that anything will be recorded.
#
# THE COST OF BEING OFF is the number that matters here: this code is inlined
# into hooks that fire on EVERY Bash call, and audit-mode is off for virtually
# every session of every user. An earlier version ran `perl` plus two `jq`
# invocations before it ever checked whether a log existed — three processes per
# hook, four hooks per command, ~48 ms on every single shell call for a feature
# nobody had turned on.
#
# So the gate is a pure-builtin one first: the per-repo audit directory only
# exists once audit-mode has been activated in this repo at least once. No
# subprocess, no parsing. Everything expensive lives behind it.
navori_audit_begin() {
  navori_audit_on=0

  navori_audit_root=${NAVORI_AUDITS_ROOT:-}
  if [ -z "$navori_audit_root" ]; then
    [ -n "${HOME:-}" ] || return 0
    navori_audit_root=$HOME/.navori/audits
  fi

  # The gate tests the audit ROOT, not the per-repo directory.
  #
  # Deriving the repo cheaply would mean `${CLAUDE_PROJECT_DIR##*/}` — and that
  # is WRONG: the authoritative repo comes from the payload's `cwd`, and the two
  # differ whenever a hook fires inside an agent worktree, since the hook process
  # starts in the main repo (#454). A gate built on the wrong name would silently
  # record nothing exactly where the harness runs its parallel work.
  #
  # The root alone is enough for what this gate is for: a user who has never
  # activated audit-mode anywhere has no `~/.navori/audits`, so the common case
  # costs one stat and zero processes. Someone who does use audit-mode pays the
  # parsing — which is the cost of the feature they turned on.
  [ -d "$navori_audit_root" ] || return 0

  navori_audit_on=1
  navori_audit_t0=$(navori_audit_now)
}

# Milliseconds since epoch, spending a process only when it has to.
#
# `$EPOCHREALTIME` is a BUILTIN in bash 5 and in zsh (with zsh/datetime, which
# the harness's zsh path already has): no fork at all. Only a shell without it
# pays for `perl`, and only a machine without perl degrades to whole seconds —
# `date` has no portable millisecond format (GNU has %s%3N, BSD does not).
navori_audit_now() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    # `1756... .123456` → milliseconds, with pure parameter expansion.
    navori_audit_epoch=${EPOCHREALTIME/,/.}
    printf '%s%s' "${navori_audit_epoch%%.*}" "$(printf '%.3s' "${navori_audit_epoch#*.}")"
    return 0
  fi
  perl -MTime::HiRes=time -e 'printf "%.0f", time*1000' 2>/dev/null \
    || printf '%s' $(( $(date +%s 2>/dev/null || echo 0) * 1000 ))
}

# navori_audit_log <verdict> [reason]
#
# `name`, `phase`, `tool` and `source` come from the caller's own variables,
# which the render sets per hook — the partial never guesses which hook it is
# inlined into.
navori_audit_log() {
  # The builtin-only gate from `navori_audit_begin`: when audit-mode was never
  # activated in this repo, nothing below runs and no process is spawned.
  [ "${navori_audit_on:-0}" = "1" ] || return 0
  # No payload, no jq, no clock → nothing to record. Each of these is a normal
  # state for a hook that bailed early, not an error worth surfacing.
  [ -n "${payload:-}" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  # ONE jq for every field, not one per field: this runs on each hook of each
  # Bash call, and a fork is the most expensive thing in it. Newline-separated,
  # read back positionally.
  # The third field is the OWNER, and it is never empty: inside a subagent the
  # host sends a real `agent_id`; on the main thread it sends none and the
  # literal below names the orchestrator explicitly.
  #
  # It used to be `// ""`, and the empty case did not stay empty — it came out
  # as the `cwd`. Command substitution strips trailing newlines, so an empty
  # third field left `$navori_audit_fields` with only two lines; then
  # `${rest#*<NL>}` found no newline in `"cwd"` and POSIX says a `#` pattern
  # that does not match returns the string UNCHANGED. 41,581 of the park's
  # 52,460 recorded owners (79%) were a filesystem path for that reason.
  #
  # The consumer's behaviour does not change — `ownerOf` looks the value up
  # among the session's agents and sends anything that names nobody to the
  # orchestrator, which is where a path already went — but the record stops
  # claiming the repo directory is an agent. Old logs keep working through the
  # same "names nobody" branch.
  #
  # The trailing "." is a sentinel, not data: with it the third field is always
  # followed by a newline, so the `%%` below cannot fall into the same trap if
  # a future field is ever empty.
  #
  # The owner is picked with an explicit "first non-empty string", NOT with
  # `.agent_id // .subagent_id // "orchestrator"`. In jq only `null` and `false`
  # are falsy, so a host that sends the key with an EMPTY string satisfies `//`
  # and the chain yields `""` — the field then disappears from the record and
  # `ownerOf` falls back to the time window, which is the guess this field
  # exists to avoid. Caught by a test, not by review.
  navori_audit_fields=$(printf '%s' "${payload:-}" | jq -r '[.session_id // "", .cwd // "", ([.agent_id, .subagent_id] | map(select(type == "string" and . != "")) | first) // "orchestrator", .tool_use_id // "", "."] | .[]' 2>/dev/null) || return 0
  navori_audit_session=${navori_audit_fields%%
*}
  navori_audit_rest=${navori_audit_fields#*
}
  navori_audit_cwd=${navori_audit_rest%%
*}
  navori_audit_rest=${navori_audit_rest#*
}
  navori_audit_agent=${navori_audit_rest%%
*}
  navori_audit_rest=${navori_audit_rest#*
}
  navori_audit_tool_use_id=${navori_audit_rest%%
*}
  [ -n "$navori_audit_session" ] || return 0
  # Same character class the CLI enforces (#503): the id composes a path, so
  # anything path-shaped means the payload is not what we think it is.
  case "$navori_audit_session" in
    *[!A-Za-z0-9_-]*) return 0 ;;
  esac

  [ -n "$navori_audit_cwd" ] || navori_audit_cwd=$PWD
  navori_audit_repo=$(navori_audit_repo_from_cwd "$navori_audit_cwd") || return 0
  [ -n "$navori_audit_repo" ] || return 0

  navori_audit_file=$navori_audit_root/$navori_audit_repo/session-$navori_audit_session.log

  # The session may not be the marked one even in a repo that has been audited
  # before. Also the writability check — a log that cannot be appended to is not
  # an error, it is simply not recording.
  if [ ! -f "$navori_audit_file" ]; then
    # SPOOL for the phase that CANNOT have a log yet (#778).
    #
    # `navori audit --start` is what creates the session log, and it runs from
    # the UserPromptSubmit hook — i.e. after the first prompt. Every SessionStart
    # hook therefore fires BEFORE the file exists, and the check above threw its
    # record away every single time: measured, `session-start-context` recorded 1
    # of ~20 startups in this repo, and the only survivor was a resume onto an
    # already-open log. "Did the session load the harness?" had no witness at all,
    # which is exactly the question the recorder exists to answer.
    #
    # So those records go to a side file that `--start` absorbs. Two deliberate
    # limits keep this from becoming a leak:
    #
    #   1. SessionStart ONLY. Every other phase runs after a prompt, so a missing
    #      log there means the session is genuinely not marked — and spooling
    #      those would write four lines per Bash call, for every session of every
    #      repo, forever. That is thousands of writes to buy nothing.
    #   2. Only where the repo's audit directory ALREADY exists, which means the
    #      repo has been audited (or armed) at least once. `mkdir` is never run
    #      from here: a repo that has never used audit-mode must stay at zero
    #      files and zero forks, the same contract as the root gate above. The
    #      cost is that the FIRST audited session of a repo still loses its
    #      SessionStart records; every one after it has them.
    #
    # FAIL-OPEN, and here more than anywhere: this runs while a session is
    # opening. Every failure path below returns 0 and writes nothing to stdout —
    # a spool that could abort a hook would make observation the reason a session
    # does not start, which is the one bug this partial may never have.
    [ "${navori_audit_phase:-}" = "SessionStart" ] || return 0
    [ -d "$navori_audit_root/$navori_audit_repo" ] || return 0
    navori_audit_file=$navori_audit_root/$navori_audit_repo/pending-$navori_audit_session.jsonl
    if [ ! -e "$navori_audit_file" ]; then
      : >> "$navori_audit_file" 2>/dev/null || return 0
    fi
  fi
  [ -w "$navori_audit_file" ] || return 0

  # Volume valve, OFF by default.
  #
  # `PreToolUse(Bash)` chains four hooks, so every shell command leaves four
  # lines and most are `skip` — a long session runs to thousands. Set
  # NAVORI_AUDIT_SKIP_NOOPS=1 to drop the ones that did nothing.
  #
  # Default off on purpose: a `skip` is the ONLY evidence that a hook ran and
  # decided it had no business acting, which is exactly what distinguishes it
  # from a hook that never executed — the question that motivated recording
  # hooks at all. The valve trades that away knowingly; it must not be the
  # silent default.
  if [ "${NAVORI_AUDIT_SKIP_NOOPS:-0}" = "1" ]; then
    case "$1" in
      skip|noop) return 0 ;;
    esac
  fi

  navori_audit_end=$(navori_audit_now)
  navori_audit_ms=$(( navori_audit_end - ${navori_audit_t0:-$navori_audit_end} ))
  [ "$navori_audit_ms" -ge 0 ] 2>/dev/null || navori_audit_ms=0

  # `tsMs` is the instant at the resolution the log actually needs (#685): the
  # `ts` below truncates to the second, and 84% of a measured session's events
  # share their second with another one. This value is already computed — the
  # duration above is derived from it — so recording it costs nothing.
  #
  # Validated with the same `-ge 0` idiom as `ms`, and for the same reason: it
  # is passed as `--argjson`, so a non-numeric value would make the whole `jq`
  # fail and the event would vanish instead of merely losing a field.
  [ "$navori_audit_end" -ge 0 ] 2>/dev/null || navori_audit_end=0

  # `ts` is NOT stamped here, and that is the whole point of #696: it was a
  # `date` fork per event — 46,850 of them across this store — for a string
  # fully derivable from the `tsMs` above, which `$EPOCHREALTIME` already
  # produced without spawning anything. The file's own cost doctrine (see
  # `navori_audit_now`) says spend a process only when there is no other way;
  # keeping this one made the comment lie four lines under the value that
  # refutes it.
  #
  # Nothing downstream lost a field: `parse.ts` derives the ISO from `tsMs`
  # when the record carries none, and logs written before this still have
  # theirs. The lifecycle records — `start`, `stop`, `session-end` — keep a real
  # `ts`, so a human reading the raw `.log` still has dated anchors; those are
  # ~3 per session, not one per hook.
  # `navori_audit_agent` came out of the same single jq above. It is what lets
  # the report attribute a hook to a subagent WITHOUT guessing: with agents
  # running in parallel their time windows overlap, so attribution by timestamp
  # is the fallback, not the primary route.
  #
  # It is recorded, never trusted as an agent identity by itself (#560). What
  # `.agent_id` means depends on the PHASE: on the tool phases it is stable —
  # 485 events of one measured session carried 11 distinct ids, and the
  # subagents' resolved to real transcripts — but on `SubagentStop` the host
  # sends a fresh id per firing: 112 distinct ids for 117 firings, 102 of them
  # matching nothing under `~/.claude`. So a consumer that resolves this field
  # must treat "names nobody" as invalid data rather than as a different agent
  # (`ownerOf` in `lib/audit/parse.ts` is where that rule lives).

  printf '%s\n' "$(jq -cn \
    --arg name "${navori_audit_name:-unknown}" \
    --arg phase "${navori_audit_phase:-unknown}" \
    --arg verdict "${1:-unknown}" \
    --arg reason "${2:-}" \
    --arg tool "${navori_audit_tool:-}" \
    --arg src "${navori_audit_source:-core}" \
    --arg agent "${navori_audit_agent:-}" \
    --arg toolUseId "${navori_audit_tool_use_id:-}" \
    --argjson ms "$navori_audit_ms" \
    --argjson tsMs "$navori_audit_end" \
    '{tsMs:$tsMs,event:"hook",name:$name,phase:$phase,verdict:$verdict,ms:$ms,source:$src}
     + (if $tool   == "" then {} else {tool:$tool}       end)
     + (if $reason == "" then {} else {reason:$reason}   end)
     + (if $agent  == "" then {} else {agentId:$agent}   end)
     + (if $toolUseId == "" then {} else {toolUseId:$toolUseId} end)' 2>/dev/null)" \
    >> "$navori_audit_file" 2>/dev/null

  return 0
}
navori_audit_begin
[ -n "${nv_project_dir:-}" ] || exit 0
advice=$(navori_bash_failure_state failure)
if [ -n "$advice" ]; then
  navori_audit_log "advise" "same Bash failure reached three consecutive occurrences"
  NV_ADVICE="$advice" node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PostToolUseFailure",additionalContext:process.env.NV_ADVICE}})+"\n")' 2>/dev/null || true
fi
exit 0
# navori:managed end id="bash-outcome-watch-base"
