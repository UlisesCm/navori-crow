/**
 * `crow detach <claude|codex>` (R26, R27; design.md D13). Removes only the units crow wrote
 * that the user has not edited, keeps and reports edited ones, and aborts without writing
 * when it cannot verify that the result is the original minus exactly those units.
 */
import { maskedDiff } from "./diff";
import {
  AttachError,
  buildContext,
  confirmChange,
  manifestPath,
  parseChangeArgs,
  readManifest,
  readSnapshot,
  reportBackup,
  writeConfig,
  writeManifest,
} from "./attach-common";
import type { AttachIo } from "./attach-common";
import { planClaudeDetach } from "./claude-config";
import { planCodexDetach } from "./codex-config";
import { rmSync } from "node:fs";

/** Runs `crow detach`; returns the exit code (0 done or nothing to do, 1 aborted). */
export async function runDetach(argv: readonly string[], io: AttachIo): Promise<number> {
  try {
    return await detach(argv, io);
  } catch (err) {
    if (!(err instanceof AttachError)) throw err;
    io.out(`crow: ${err.message}`);
    return 1;
  }
}

async function detach(argv: readonly string[], io: AttachIo): Promise<number> {
  const args = parseChangeArgs(argv);
  const ctx = buildContext(args, io);
  const snapshot = readSnapshot(ctx.configPath);
  if (snapshot.text === null) {
    io.out(`${ctx.configPath} does not exist; nothing to detach`);
    return 0;
  }
  const prior = readManifest(ctx);
  const plan =
    args.engine === "claude"
      ? planClaudeDetach(snapshot.text, prior, ctx)
      : planCodexDetach(snapshot.text, prior, ctx);
  for (const k of plan.kept) {
    io.out(`kept crow entry ${k.event}: ${k.reason}`);
  }
  if (plan.removed.length === 0) {
    io.out(`no unmodified crow entries in ${ctx.configPath}; nothing to remove`);
    return 0;
  }
  io.out(maskedDiff(snapshot.text, plan.after, { label: ctx.configPath }));
  await confirmChange(io, args.yes);

  const { backup } = writeConfig(ctx, snapshot, plan.after, io);
  reportBackup(io, backup);
  if (plan.manifest !== null) {
    if (plan.manifest.units.length === 0) rmSync(manifestPath(ctx), { force: true });
    else writeManifest(ctx, plan.manifest);
  }
  io.out(
    `detached ${args.engine}: ${plan.removed.length} entr(ies) removed from ${ctx.configPath}`,
  );
  if (plan.kept.length > 0) io.out(`${plan.kept.length} edited crow entr(ies) kept`);
  return 0;
}
