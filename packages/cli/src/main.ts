#!/usr/bin/env bun
import { homedir } from "node:os";
import { UP_HELP, runUp } from "./commands/up";
import { DOCTOR_HELP, runDoctor } from "./doctor";

const USAGE = `usage: crow <command>

  up [--otlp] [--otlp-port <n>] [--port <n>]   start the crow server
  doctor [--json]                              report lane health per engine
`;

const [command, ...rest] = process.argv.slice(2);

try {
  if (command === "up") {
    if (rest.includes("--help") || rest.includes("-h")) console.log(UP_HELP);
    else await runUp(rest);
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
