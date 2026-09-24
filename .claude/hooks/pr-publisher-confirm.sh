# navori:managed start id="pr-publisher-confirm-base" hash="e4b94f8a" version="0.10.0" source="@navori/core"
#!/usr/bin/env bash
#
# PreToolUse(Bash): a `gh pr create` that did NOT come from the
# `publisher` is raised to a user confirmation.
#
# WHY (#705): the publisher is the single owner of commit+PR, and it is invoked on
# 15% of the PRs this harness opens. The rate is not uniform — one park repo
# runs at 48%, and the repo that PUBLISHES the publisher sat at 0 of 101. The
# confound was checked and does not hold: in the sessions where subagents were
# demonstrably available and used, the publisher was still never called. The publisher
# is not skipped; its antechamber is never entered, because `gh pr create` falls
# out of whatever the main agent was already doing and nothing interrupts it.
#
# So this hook interrupts, and does no more than that. It does NOT block: a
# session where the operator forbids subagents has no way to reach the publisher,
# and a hook that made PRs impossible there would be worse than the deviation it
# corrects. `ask` keeps the decision with the human while removing the one thing
# measured to fail — a layer that only suggests.
set -euo pipefail

# Command extraction (payload → $cmd). Shared body, single source of truth.
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
payload=$(cat)
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

# Gate to `gh pr create` only. $TRIGGER_RE is consumed by the shared detector
# inlined below, which splits compound commands on && || ; | and matches at a
# segment START — so `git push … && gh pr create …` is caught and an
# `echo "gh pr create"` is not.
TRIGGER_RE='^gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)'
# Literal substring every branch of $TRIGGER_RE needs, read by the fast path in
# the shared detector (spec 0016). `create` rather than `gh`: both are necessary
# conditions, and the rarer one skips the fork on more commands. Keep NEXT to
# the regex — a branch added there without its token here loses the shortcut.
TRIGGER_TOKENS='create'
# Shared gate detector — inlined into each hook at render time (see the include
# directive in the source scripts + lib/render/hook-includes.ts). The caller MUST set
# $TRIGGER_RE (an ERE) before the include; it decides which git ops this hook
# gates. Single source of truth for the FIX B/C wrapper-peeling logic; DO NOT
# copy this body into a hook by hand.
#
# Detect whether $1 (a possibly-compound command) invokes a gated operation.
# Splits $1 on the shell separators && || ; | and newlines, strips leading
# whitespace plus wrapper words (`(`, `\`, `command `) and `VAR=value` env
# prefixes from each segment, and returns 0 if ANY segment STARTS with a gated
# `git …` invocation on a word boundary (matched by $TRIGGER_RE). Replaces
# literal-prefix `case` matching, which silently skipped the gate for
# `cd x && git commit`, `echo y; git push`, or a leading space (#88: NEVER skip
# the gate silently). Matching a segment START means a quoted `echo "git commit"`
# does NOT trigger it. Known limitation: it cannot see through `sh -c`, `eval`,
# or obfuscation — a seatbelt, not a sandbox.
# The fast path on its own, so a caller can apply it EARLIER than the segment
# scan — before it has even paid to extract the command from the payload.
#
# Returns 0 when $1 may contain a gated operation, 1 when it provably cannot.
# The argument is the one the block below spells out: no $TRIGGER_RE can match
# without one of the caller's literal TOKENS appearing in the segment it
# matches, and every segment is a substring of the input. So the absence of
# every token is proof that no segment can match — and the same proof holds one
# level up, over the raw PAYLOAD the command was extracted from: JSON escaping
# touches `"`, `\` and control characters, never the letters of a token.
#
# Disarms when $TRIGGER_TOKENS is unset: with no tokens declared there is
# nothing to prove absent, so it answers "maybe" and the caller does the work.
# Fail-open to the SLOW path, never to a skip.
has_trigger_token() {
  [ -n "${TRIGGER_TOKENS:-}" ] || return 0
  # Token iteration goes through newline-split + `read`, NOT `for _tok in
  # $TRIGGER_TOKENS`: zsh does not word-split an unquoted expansion, so the
  # `for` form iterated ONCE with the whole list as a single token there — and
  # a token that can never match is a gate that never fires. Caught by the
  # bash×zsh differential suite.
  local _input="$1" _tok _nl=$'\n'
  local _toks="${TRIGGER_TOKENS// /$_nl}"
  while IFS= read -r _tok; do
    [ -n "$_tok" ] || continue
    case "$_input" in *"$_tok"*) return 0 ;; esac
  done <<< "$_toks"
  return 1
}

is_scan_trigger() {
  # Pre-expanded newline: zsh does NOT expand $'\n' in the REPLACEMENT of
  # ${var//pat/repl} (it inserts the literal characters), so an inline $'\n'
  # left compound commands unsplit there and the gate silently skipped
  # `cd x && git commit` (#391). A plain variable expands identically in
  # bash and zsh. ($'\n' in PATTERN position expands fine in both.)
  local input="$1" segment nl=$'\n'

  # ─── Fast path (spec 0016 T3.2, second pass): the loop below pays one
  # `grep -qE` FORK per segment — and a heredoc body or a 40-step compound
  # is 40 segments, so the field cost scaled with command length (measured:
  # 2.8 ms trivial, 14.8 ms for a 199-char heredoc, 95.8 ms for 40 segments;
  # p50 across one real session's commands was 40 ms per hook, not the
  # trivial floor). No $TRIGGER_RE can match without one of the caller's
  # literal TOKENS appearing in the segment it matches — and every segment is
  # a substring of the input, transformed only by insertions (`\<NL>` → space,
  # separators → newline) and prefix-peeling, none of which can CREATE a
  # token. So a single in-process substring scan of the raw input is a strict
  # superset of the segment matches: if no token is present, no segment can
  # match, and the gate answers "not for me" without a single fork. Same
  # argument, same safe direction, as the guard's own fast path.
  #
  # $TRIGGER_TOKENS is set by the including hook NEXT TO its $TRIGGER_RE, so
  # the pair travels together; when unset the fast path disarms and the loop
  # runs exactly as before (fail-open to the SLOW path, never to a skip).
  # Token iteration goes through newline-split + `read`, NOT `for _tok in
  # $TRIGGER_TOKENS`: zsh does not word-split an unquoted expansion, so the
  # `for` form iterated ONCE with the whole list as a single token there — and
  # a token that can never match is a gate that never fires. Caught by the
  # bash×zsh differential suite; same class as the $'\n' pitfall above.
  has_trigger_token "$input" || return 1
  # FIX B: join `\<newline>` continuations into a space FIRST, so a command
  # split across lines with a trailing backslash stays ONE logical segment
  # (otherwise the subcommand/flag lands in a segment not starting with git).
  input="${input//\\$'\n'/ }"
  input="${input//&&/$nl}"
  input="${input//||/$nl}"
  input="${input//;/$nl}"
  input="${input//|/$nl}"
  # `<<<` feeds the already-expanded value as data — no re-evaluation — so a
  # command that contains backticks/$() is inspected, never executed.
  while IFS= read -r segment; do
    segment="${segment#"${segment%%[![:space:]]*}"}"        # strip leading ws
    # FIX C: peel wrappers so `(git …`, `\git`, `command git …` and
    # `VAR=val git …` all reduce to a plain `git …` before matching.
    while [[ "$segment" == \(* ]]; do                       # strip leading ( runs
      segment="${segment#\(}"
      segment="${segment#"${segment%%[![:space:]]*}"}"
    done
    segment="${segment#\\}"                                 # strip a leading backslash (\git)
    while [[ "$segment" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; do  # strip VAR=val prefixes
      case "$segment" in
        *[[:space:]]*)
          segment="${segment#*[[:space:]]}"
          segment="${segment#"${segment%%[![:space:]]*}"}"
          ;;
        *) segment=""; break ;;
      esac
    done
    if [[ "$segment" == command\ * ]]; then                 # strip a leading `command ` word
      segment="${segment#command }"
      segment="${segment#"${segment%%[![:space:]]*}"}"
    fi
    # FIX C: allow git global options between `git` and the subcommand
    # (`git -c k=v commit`, `git -C /repo push`). $TRIGGER_RE's trailing boundary
    # keeps `git commitgraph` / `git config …` from matching.
    if printf '%s' "$segment" | grep -qE "$TRIGGER_RE"; then
      return 0
    fi
  done <<< "$input"
  return 1
}

# THE CHEAP GATE, and it comes before everything that costs a process.
#
# This hook fires on EVERY Bash call and does real work on almost none of them,
# and until this line it paid for that privilege twice: `extract_cmd` forks jq
# (or node) to read the command, and the `skip` record forks jq again to write
# "I ran and it was not a PR". Measured on a `git status` payload: 24.8 ms per
# Bash call, half of the ~48 ms that already forced `audit-log.sh` to be
# redesigned.
#
# `has_trigger_token` answers from the payload navori already has in memory,
# with no fork at all, and its answer is a proof rather than a guess: the
# command is a substring of the payload, and JSON escaping cannot break a token
# apart. No token in the payload → no segment can match → nothing here concerns
# this hook.
#
# WHAT IS GIVEN UP: the `skip` record for those calls. It says "the hook ran and
# the command was not a PR" — 99.9% of its firings — and it cost two forks to
# produce. Every record that carries information (`ask`, `allow`) is still
# written below. Same trade as #696, for the same reason.
has_trigger_token "${payload:-}" || exit 0

cmd=$(extract_cmd)

navori_audit_name="pr-publisher-confirm"
navori_audit_phase="PreToolUse"
navori_audit_tool="Bash"
# Fail-open no-ops, overwritten by the real definitions the include brings in.
# Same contract as the sibling gates: a recorder may never kill what it observes.
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

# The verdict is derived once, in a trap, rather than by a call per branch —
# this fires on EVERY Bash call and does real work on almost none of them.
navori_audit_verdict="skip"
navori_audit_reason="el comando no abre un PR"
navori_audit_on_exit() {
  navori_audit_log "$navori_audit_verdict" "$navori_audit_reason" || true
  return 0
}
trap navori_audit_on_exit EXIT

# An EMPTY $cmd means nothing could be read from the tool input, not "some
# command that isn't a PR". Unlike the quality gate, the fail-open direction
# here is to stay quiet: this hook's worst case is a false confirmation prompt
# on every Bash call, which would train the user to dismiss it unread — and a
# prompt nobody reads is worth less than no prompt at all.
[ -n "$cmd" ] || exit 0
is_scan_trigger "$cmd" || exit 0

# Who is running it. Inside a subagent the host sends a real `agent_id` on the
# tool phases; the main thread sends none. Measured over the park's audit logs:
# 10,879 events carried a real id and every one of them resolved to a subagent.
#
# Read HERE, not at the top: `payload_field` may spawn a process, and by this
# line we already know the command is the rare one that needs the answer.
#
# It names SOME subagent, not specifically the publisher — a `scout` opening a
# PR would pass. That is deliberate: this is a routing nudge, not a security
# boundary, and the detector cannot see through `sh -c` either.
navori_pr_agent=$(payload_field agent_id)
[ -n "$navori_pr_agent" ] || navori_pr_agent=$(payload_field subagent_id)
if [ -n "$navori_pr_agent" ]; then
  navori_audit_verdict="allow"
  navori_audit_reason="el PR viene de un subagente"
  exit 0
fi

navori_audit_verdict="ask"
navori_audit_reason="PR abierto fuera del publisher"

# `ask` routes the call to the user instead of resolving it. The reason is what
# they read, so it says what the publisher adds and how to get it — a prompt that
# only says "are you sure" is a tax, not a routing signal.
#
# jq builds it: the reason travels inside JSON and a hand-rolled string would
# break on the first quote. No jq (not preinstalled on macOS) → stay silent
# rather than emit malformed JSON, which the host rejects with a wall of schema
# text that teaches the user to ignore this hook.
command -v jq >/dev/null 2>&1 || exit 0

# The message lands in its own assignment rather than inline in the jq call.
# A heredoc nested inside `"$( ... )"` is parsed by the shell BEFORE the quoted
# delimiter takes effect for the outer context, so the apostrophe in "repo's"
# and the backticks around `gh pr create` opened quotes that were never closed
# and the file failed `bash -n` outright. Caught by the syntax check; it would
# have shipped a hook that cannot run to every repo in the park.
navori_pr_reason=$(cat <<'MSG'
[navori] this `gh pr create` does not come from the publisher.

The publisher is the single owner of commit+PR: it applies the title/body format
this repo uses and runs the git/gh pre-flight before opening anything.

Delegate it with the Agent tool (subagent_type: publisher), or confirm to
open this PR by hand — a rollout PR, a revert, or a session where subagents are
unavailable are all legitimate reasons to do so.
MSG
)

jq -cn --arg reason "$navori_pr_reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$reason}}'
exit 0
# navori:managed end id="pr-publisher-confirm-base"
