# navori:managed start id="audit-mode-close-base" hash="95dc820b" version="0.10.0" source="@navori/core"
#!/usr/bin/env bash
# navori — audit-mode close (SessionEnd)
#
# Seals the session's append-only log when the session ends. It does NOT ask
# and does NOT generate the report: SessionEnd has no one to ask — the human is
# already gone — and the log is immutable, so `navori audit` can build the
# report later, tomorrow or in two weeks, from the same intact file.
#
# FAIL-OPEN ABSOLUTE: exit 0 on anything unexpected.

set +e

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

payload=$(cat 2>/dev/null) || exit 0
[ -n "$payload" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

session_id=$(printf '%s' "$payload" | jq -r '.session_id // ""' 2>/dev/null) || exit 0
cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""' 2>/dev/null) || exit 0
reason=$(printf '%s' "$payload" | jq -r '.reason // .matcher // "other"' 2>/dev/null) || reason="other"
[ -n "$session_id" ] || exit 0
[ -n "$cwd" ] || cwd=$PWD

repo=$(navori_audit_repo_from_cwd "$cwd") || exit 0
[ -n "$repo" ] || exit 0

if [ -n "$NAVORI_AUDITS_ROOT" ]; then
  audits_root=$NAVORI_AUDITS_ROOT
else
  [ -n "$HOME" ] || exit 0
  audits_root=$HOME/.navori/audits
fi
log_file=$audits_root/$repo/session-$session_id.log

[ -f "$log_file" ] || exit 0

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || ts=""
printf '%s\n' "$(jq -cn --arg ts "$ts" --arg r "$reason" \
  '{ts:$ts,event:"session-end",reason:$r}' 2>/dev/null)" >> "$log_file" 2>/dev/null

exit 0
# navori:managed end id="audit-mode-close-base"
