/**
 * `crow detach <claude|codex>` (R26, R27; design.md D13). Removes only the units crow wrote
 * that the user has not edited, keeps and reports edited ones, and aborts without writing
 * when it cannot verify that the result is the original minus exactly those units.
 */
import { maskedDiff } from "./diff";
import {
  AttachError,
  applyOtlpConfig,
  buildContext,
  crowEnvValues,
  isOtlpUnit,
  confirmChange,
  manifestPath,
  maskOptions,
  otherEngineHasOtlp,
  parseChangeArgs,
  planOtlpConfigOff,
  readManifest,
  readSnapshot,
  reportBackup,
  writeConfig,
  writeManifest,
} from "./attach-common";
import type { AttachIo, OtlpConfigPlan } from "./attach-common";
import { parseClaudeSettings, planClaudeDetach } from "./claude-config";
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
  // The receiver goes off only when no engine keeps OTLP units and the user did not edit it.
  // This is evaluated even when the engine file needs no change (the user may have deleted
  // crow's env keys by hand).
  let cfg: OtlpConfigPlan | null = null;
  const notes: string[] = [];
  const written = plan.manifest?.otlpConfig;
  if (written !== undefined) {
    if (plan.manifest?.units.some(isOtlpUnit) || otherEngineHasOtlp(args, io)) {
      notes.push(
        "kept the OTLP receiver enabled in config.json: an engine still has OTLP settings",
      );
    } else {
      const off = planOtlpConfigOff(ctx, written);
      cfg = off.plan;
      if (off.edited) notes.push("kept config.json: the OTLP settings were edited since attach");
      if (cfg)
        notes.push(`${cfg.path} will turn the OTLP receiver off (crow wrote its otlp settings)`);
    }
  }
  const engineChanged = plan.removed.length > 0;
  if (!engineChanged && cfg === null && plan.manifest === prior) {
    io.out(`no unmodified crow entries in ${ctx.configPath}; nothing to remove`);
    return 0;
  }
  if (engineChanged) {
    const env =
      args.engine === "claude" ? parseClaudeSettings(snapshot.text, ctx.configPath)["env"] : null;
    io.out(
      maskedDiff(
        snapshot.text,
        plan.after,
        maskOptions(ctx.configPath, env, io, crowEnvValues(prior)),
      ),
    );
  }
  for (const n of notes) io.out(n);
  await confirmChange(io, args.yes);

  if (engineChanged) {
    const { backup } = writeConfig(ctx, snapshot, plan.after, io);
    reportBackup(io, backup);
  }
  if (cfg) applyOtlpConfig(ctx, cfg, io);
  if (plan.manifest !== null) {
    const { otlpConfig: _drop, ...rest } = plan.manifest;
    const manifest = cfg || written === undefined ? rest : plan.manifest;
    if (manifest.units.length === 0) rmSync(manifestPath(ctx), { force: true });
    else writeManifest(ctx, manifest);
  }
  if (cfg) io.out("OTLP receiver off in config.json: restart crow (crow up) if it is running");
  io.out(
    `detached ${args.engine}: ${plan.removed.length} entr(ies) removed from ${ctx.configPath}`,
  );
  if (plan.kept.length > 0) io.out(`${plan.kept.length} edited crow entr(ies) kept`);
  return 0;
}
