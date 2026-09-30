/**
 * `crow attach <claude|codex>` (R21-R25, R27; design.md D13/D14). Flow: parse the engine's
 * user-level config (abort if unreadable) -> compute the change -> masked diff -> explicit
 * confirmation -> race check -> backup + atomic write -> manifest. Only the engine's own
 * config file and `$CROW_HOME` are ever written (R23). Content-logging flags are never
 * written (R24); the OTLP `env` lane is not part of this command yet.
 */
import { formatChangeNotice, maskedDiff } from "./diff";
import {
  AttachError,
  buildContext,
  confirmChange,
  hookScriptState,
  parseChangeArgs,
  readManifest,
  readSnapshot,
  reportBackup,
  writeConfig,
  writeHookScript,
  writeManifest,
} from "./attach-common";
import type { AttachIo } from "./attach-common";
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
  for (const w of plan.warnings) io.out(`warning: ${w}`);
  if (!Bun.which("curl")) io.out("warning: curl is not in PATH; the hook script will do nothing");

  if (plan.added.length === 0 && !script.changed) {
    io.out(`${args.engine} is already attached; nothing to do`); // R25
    return 0;
  }

  const before = snapshot.text ?? "";
  if (plan.added.length > 0) {
    const notice =
      args.engine === "claude" && before.trim() !== "" ? formatChangeNotice(before) : null;
    if (notice) io.out(`note: ${notice}`);
    const env =
      args.engine === "claude" ? parseClaudeSettings(snapshot.text, ctx.configPath)["env"] : null;
    io.out(
      maskedDiff(before, plan.after, {
        label: ctx.configPath,
        maskKeys: typeof env === "object" && env !== null ? Object.keys(env) : [],
        ...(io.env["CROW_TOKEN"] ? { secrets: [io.env["CROW_TOKEN"]] } : {}),
      }),
    );
  } else {
    io.out(`${ctx.configPath} already has crow's hooks`);
  }
  if (script.changed)
    io.out(`the hook script ${ctx.hookPath} will be (re)written (port ${ctx.port})`);

  await confirmChange(io, args.yes);

  writeHookScript(ctx, script.content);
  if (plan.added.length > 0) {
    const { backup } = writeConfig(ctx, snapshot, plan.after, io);
    reportBackup(io, backup);
    writeManifest(ctx, plan.manifest);
  }
  io.out(`attached ${args.engine}: ${plan.added.length} hook(s) added to ${ctx.configPath}`);
  if (args.engine === "codex") {
    io.out(
      "Open Codex and run /hooks to review and trust crow's 10 hooks; it will not run them before.",
    );
  }
  return 0;
}
