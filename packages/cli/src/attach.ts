/**
 * `crow attach <claude|codex>` (R21-R25, R27, R34; design.md D13/D14). Flow: parse the engine's
 * user-level config (abort if unreadable) -> compute the change (hooks plus the OTLP lane) ->
 * masked diff -> explicit confirmation -> race check -> backup + atomic write -> manifest.
 * Only the engine's own config file and `$CROW_HOME` are ever written (R23). Content-logging
 * flags are never written (R24). The OTLP lane is always written, unless the user's own
 * `OTEL_*` / `[otel]` conflicts with it (then it is omitted and reported).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatChangeNotice, maskedDiff } from "./diff";
import {
  AttachError,
  applyOtlpConfig,
  buildContext,
  confirmChange,
  crowEnvValues,
  hookScriptState,
  maskOptions,
  parseChangeArgs,
  planOtlpConfigOn,
  readManifest,
  readSnapshot,
  reportBackup,
  writeConfig,
  writeHookScript,
  writeManifest,
} from "./attach-common";
import type { AttachIo, Manifest, OtlpConfigPlan } from "./attach-common";
import { parseClaudeSettings, planClaudeAttach } from "./claude-config";
import { planCodexAttach } from "./codex-config";

/** Runs `crow attach`; returns the exit code (0 done or unchanged, 1 aborted). */
export async function runAttach(argv: readonly string[], io: AttachIo): Promise<number> {
  try {
    return await attach(argv, io);
  } catch (err) {
    if (!(err instanceof AttachError)) throw err;
    io.out(`crow: ${err.message}`);
    return 1;
  }
}

async function attach(argv: readonly string[], io: AttachIo): Promise<number> {
  const args = parseChangeArgs(argv);
  const ctx = buildContext(args, io);
  const snapshot = readSnapshot(ctx.configPath);
  const prior = readManifest(ctx);
  const plan =
    args.engine === "claude"
      ? planClaudeAttach(snapshot.text, prior, ctx)
      : planCodexAttach(snapshot.text, prior, ctx);
  const script = hookScriptState(ctx);
  const cfg: OtlpConfigPlan | null = plan.otlp.active ? planOtlpConfigOn(ctx) : null;
  for (const w of plan.warnings) io.out(`warning: ${w}`);
  if (!Bun.which("curl")) io.out("warning: curl is not in PATH; the hook script will do nothing");
  const hooksJson = join(dirname(ctx.configPath), "hooks.json");
  if (args.engine === "codex" && existsSync(hooksJson)) {
    io.out(
      `warning: ${hooksJson} exists; Codex will merge it with crow's hooks in config.toml and warn at startup (D14)`,
    );
  }

  const engineChanged = plan.added.length > 0 || plan.otlp.added.length > 0;
  if (!engineChanged && !script.changed && !cfg?.changed) {
    io.out(`${args.engine} is already attached; nothing to do`); // R25
    return 0;
  }

  const before = snapshot.text ?? "";
  if (engineChanged) {
    const notice =
      args.engine === "claude" && before.trim() !== "" ? formatChangeNotice(before) : null;
    if (notice) io.out(`note: ${notice}`);
    const env =
      args.engine === "claude" ? parseClaudeSettings(snapshot.text, ctx.configPath)["env"] : null;
    io.out(
      maskedDiff(before, plan.after, maskOptions(ctx.configPath, env, io, crowEnvValues(prior))),
    );
  } else {
    io.out(`${ctx.configPath} already has crow's hooks`);
  }
  if (script.changed)
    io.out(`the hook script ${ctx.hookPath} will be (re)written (port ${ctx.port})`);
  if (cfg?.changed) {
    io.out(
      `${cfg.path} will enable the OTLP receiver (otlp.enabled = true${cfg.value.port !== undefined ? `, port ${cfg.value.port}` : ""})`,
    );
  }

  await confirmChange(io, args.yes);

  writeHookScript(ctx, script.content);
  if (engineChanged) {
    const { backup } = writeConfig(ctx, snapshot, plan.after, io);
    reportBackup(io, backup);
  }
  if (cfg?.changed) applyOtlpConfig(ctx, cfg, io);
  if (engineChanged || cfg?.changed) {
    const manifest: Manifest = cfg ? { ...plan.manifest, otlpConfig: cfg.value } : plan.manifest;
    writeManifest(ctx, manifest);
  }
  io.out(
    `attached ${args.engine}: ${plan.added.length} hook(s) and ${plan.otlp.added.length} OTLP setting(s) added to ${ctx.configPath}`,
  );
  if (cfg?.changed) {
    io.out("OTLP enabled in config.json: restart crow (crow up) if it is running to apply it");
  }
  if (args.engine === "codex") {
    io.out(
      "Open Codex and run /hooks to review and trust crow's 10 hooks; it will not run them before.",
    );
  }
  return 0;
}
