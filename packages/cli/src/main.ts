#!/usr/bin/env bun
import { UP_HELP, runUp } from "./commands/up";

const USAGE = `usage: crow <command>

  up [--otlp] [--otlp-port <n>] [--port <n>]   start the crow server
`;

const [command, ...rest] = process.argv.slice(2);

try {
  if (command === "up") {
    if (rest.includes("--help") || rest.includes("-h")) console.log(UP_HELP);
    else await runUp(rest);
  } else {
    console.log(USAGE);
    process.exit(command === undefined || command === "--help" ? 0 : 1);
  }
} catch (err) {
  console.error(`crow: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
