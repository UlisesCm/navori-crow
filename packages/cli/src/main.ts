#!/usr/bin/env bun
import { homedir } from "node:os";
import { UP_HELP, runUp } from "./commands/up";
import { runAttach } from "./attach";
import { ATTACH_HELP, defaultIo } from "./attach-common";
import { runDetach } from "./detach";
import { DOCTOR_HELP, runDoctor } from "./doctor";

const USAGE = `usage: crow <command>

  up [--otlp] [--otlp-port <n>] [--port <n>]   start the crow server
  attach <claude|codex> [--yes] [--port <n>]   register crow's hooks in the engine config
  detach <claude|codex> [--yes]                remove the unmodified crow hooks
  doctor [--json]                              report lane health per engine
`;

const [command, ...rest] = process.argv.slice(2);

try {
  if (command === "up") {
    if (rest.includes("--help") || rest.includes("-h")) console.log(UP_HELP);
    else await runUp(rest);
  } else if (command === "attach" || command === "detach") {
    if (rest.includes("--help") || rest.includes("-h")) console.log(ATTACH_HELP);
    else {
      const io = defaultIo(process.env, homedir());
      process.exitCode = await (command === "attach" ? runAttach(rest, io) : runDetach(rest, io));
    }
  } else if (command === "doctor") {
    if (rest.includes("--help") || rest.includes("-h")) console.log(DOCTOR_HELP);
    else process.exitCode = await runDoctor(rest, { env: process.env, homeDir: homedir() });
  } else {
    console.log(USAGE);
    process.exit(command === undefined || command === "--help" ? 0 : 1);
  }
} catch (err) {
  console.error(`crow: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
