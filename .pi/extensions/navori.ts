// navori:managed-file id="pi-extension" hash="bd3ca185106caeb1f5580f97aac68bba1766cd8fe442156b7a35118c782980ed"
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { VERSION, defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";


function assertTrustedPiParent(ctx: { isProjectTrusted?: () => boolean }): void {
  let trusted = false;
  try {
    trusted = ctx.isProjectTrusted?.() === true;
  } catch {
    // A missing or failing Pi trust API is not permission to run a child.
  }
  if (!trusted) throw new Error("Navori Pi subagent requires a trusted parent project");
}

const MIN_PI_VERSION = "0.87.1";
const MIN_NODE_VERSION = "22.19.0";
function XT(e){let t=/^v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(e.trim());if(!t)return null;let n=Number(t[1]),r=Number(t[2]),i=Number(t[3]);return[n,r,i].every(Number.isSafeInteger)?[n,r,i]:null}
function QT(e,t){return e[0]===t[0]?e[1]===t[1]?e[2]>=t[2]:e[1]>t[1]:e[0]>t[0]}
function $T(e,t=process.versions.node){let n=XT(t);if(!n||!QT(n,[22,19,0]))throw Error(`Navori's Pi engine requires Node.js ${YT} or later; found ${t}.`);let r=XT(e);if(!r||!QT(r,[0,87,1]))throw Error(`Navori's Pi engine requires @earendil-works/pi-coding-agent ${JT} or later; found ${e}. Run pi --version and upgrade Pi.`)}


type Role = "scout" | "implementer" | "reviewer";
type RoleSpec = { name: Role; description: string; model?: string; tools: string[]; instructions: string };
type Controls = { planTiers: boolean; masterPlan: boolean; scribeOwnsMarkdown: boolean };
const ROLES = new Set<Role>(["scout", "implementer", "reviewer"]);
const ROLE_TOOLS: Record<Role, ReadonlySet<string>> = {
  scout: new Set(["read", "grep", "find", "ls", "write"]),
  implementer: new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]),
  reviewer: new Set(["read", "grep", "find", "ls", "bash", "write"]),
};
const MAX_CHILDREN = 3;
const TIMEOUT_MS = 600_000;
const GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 65_536;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function controls(cwd: string): Controls {
  const manifest: unknown = JSON.parse(readFileSync(join(cwd, ".pi/navori.json"), "utf8"));
  if (!isRecord(manifest) || !isRecord(manifest.controls)) {
    return { planTiers: false, masterPlan: false, scribeOwnsMarkdown: false };
  }
  const value = manifest.controls;
  if (typeof value.planTiers !== "boolean" || typeof value.masterPlan !== "boolean" ||
      typeof value.scribeOwnsMarkdown !== "boolean") throw new Error("Invalid Navori Pi controls");
  return { planTiers: value.planTiers, masterPlan: value.masterPlan,
    scribeOwnsMarkdown: value.scribeOwnsMarkdown };
}

function runNavori(cwd: string, args: string[], input: string, signal: AbortSignal): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("navori", args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    let stopped = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    const timeout = setTimeout(stop, 10_000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > 65_536) stop();
    });
    child.on("error", (cause: Error) => reject(cause));
    child.on("close", (code: number | null) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", stop);
      if (stopped || signal.aborted || Buffer.byteLength(stdout) > 65_536) reject(new Error("Navori control aborted, timed out, or oversized"));
      else resolve({ code, stdout });
    });
  });
}

async function checkDispatch(cwd: string, role: Role, task: string,
    feature: string | undefined, signal: AbortSignal): Promise<void> {
  if (role === "implementer" && controls(cwd).planTiers) {
    const payload = JSON.stringify({ cwd, tool_input: { agent_type: role, message: task } });
    let result;
    try { result = await runNavori(cwd, ["plan", "gate"], payload, signal); }
    catch { throw new Error("Navori plan gate unavailable; subagent blocked"); }
    if (result.code !== 0) throw new Error("Navori plan gate blocked the implementer");
  }
  if (role === "reviewer") {
    if (!feature || !/^[a-z0-9][a-z0-9_-]*$/.test(feature)) {
      throw new Error("Reviewer requires an explicit Navori feature slug for handoff check");
    }
    let result;
    try { result = await runNavori(cwd, ["handoff", "check", feature,
      "--for", "orchestrator", "--cwd", cwd, "--dir", ".navori/state/handoffs", "--json"],
      "", signal); }
    catch { throw new Error("Navori handoff check unavailable; reviewer blocked"); }
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error("Invalid Navori handoff check JSON; reviewer blocked"); }
    if (result.code !== 0 || !isRecord(parsed) || parsed.status !== "ok" ||
        parsed.feature !== feature) throw new Error("Navori handoff check did not pass; reviewer blocked");
  }
}

function roleSpec(cwd: string, role: Role): RoleSpec {
  const manifest: unknown = JSON.parse(readFileSync(join(cwd, ".pi/navori.json"), "utf8"));
  if (!isRecord(manifest) || !Array.isArray(manifest.agents) || !manifest.agents.includes(role)) {
    throw new Error("Navori Pi role is not enabled: " + role);
  }
  const raw = readFileSync(join(cwd, ".pi/agents", role + ".md"), "utf8");
  const match = /^---\n(?:#[^\n]*\n)?([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error("Invalid Pi role definition: " + role);
  const fields = new Map<string, unknown>();
  for (const line of match[1].split("\n")) {
    const field = /^([a-z]+): (.+)$/.exec(line);
    if (!field) throw new Error("Invalid Pi role field: " + role);
    fields.set(field[1], JSON.parse(field[2]));
  }
  const tools = fields.get("tools");
  if (fields.get("name") !== role || typeof fields.get("description") !== "string" ||
      !Array.isArray(tools) || !tools.every((tool: unknown) => typeof tool === "string" && ROLE_TOOLS[role].has(tool))) {
    throw new Error("Unknown or missing Pi role tool mapping: " + role);
  }
  const model = fields.get("model");
  if (model !== undefined && typeof model !== "string") throw new Error("Invalid Pi role model: " + role);
  return { name: role, description: fields.get("description") as string, model: model as string | undefined,
    tools: tools as string[], instructions: match[2].trim() };
}

function finalText(jsonl: string): string {
  let text = "";
  let settled = false;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { throw new Error("Invalid Pi child JSONL event"); }
    if (!isRecord(event)) throw new Error("Invalid Pi child JSONL event");
    if (event.type === "agent_settled") settled = true;
    if (event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") continue;
    const blocks = event.message.content;
    if (!Array.isArray(blocks)) continue;
    const parts = blocks.filter((block: unknown): block is { type: string; text: string } =>
      isRecord(block) && block.type === "text" && typeof block.text === "string");
    text = parts.map((part) => part.text).join("\n");
  }
  if (!settled) throw new Error("Pi child stopped before agent_settled");
  return text.slice(0, MAX_OUTPUT_BYTES);
}

function runChild(cwd: string, role: RoleSpec, task: string, parentSignal: AbortSignal): Promise<string> {
  const args = ["--mode", "json", "--no-session", "--approve"];
  if (role.model) args.push("--model", role.model);
  if (role.tools.length) args.push("--tools", role.tools.join(","));
  else args.push("--no-tools");
  args.push("--", role.instructions + "\n\nTask: " + task);
  return new Promise<string>((resolve, reject) => {
    const child = spawn("pi", args, { cwd, env: { ...process.env, NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: role.name },
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stopping = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      const kill = (signal: NodeJS.Signals): void => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* Process already exited. */ }
      };
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), GRACE_MS);
    };
    const timeout = setTimeout(stop, TIMEOUT_MS);
    const abort = (): void => stop();
    parentSignal.addEventListener("abort", abort, { once: true });
    if (parentSignal.aborted) stop();
    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(output) <= MAX_OUTPUT_BYTES * 4) output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES * 4) stop();
    });
    child.stderr.resume();
    child.on("error", (cause: Error) => { stop(); reject(cause); });
    child.on("close", (code: number | null) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      parentSignal.removeEventListener("abort", abort);
      if (stopping) reject(new Error("Pi child cancelled, timed out, or exceeded output limit"));
      else if (code !== 0) reject(new Error("Pi child exited " + code + "; inspect Pi auth with /login openai-codex"));
      else { try { resolve(finalText(output)); } catch (cause) { reject(cause); } }
    });
  });
}

export default function (pi: ExtensionAPI): void {
  try {
    assertSupportedPiRuntime(VERSION);
  } catch (cause) {
    process.stderr.write((cause instanceof Error ? cause.message : "Unsupported Pi runtime") + "\n");
    return;
  }
  pi.on("tool_call", async (event, ctx) => {
    if (!controls(ctx.cwd).scribeOwnsMarkdown || process.env.NAVORI_PI_CHILD_ROLE !== "implementer") return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const input: unknown = event.input;
    if (!isRecord(input) || typeof input.path !== "string") return;
    if (/\.mdx?$/i.test(input.path)) {
      return { block: true, reason: "Navori scribe owns Markdown; direct Pi edit/write blocked. Bash is outside this advisory boundary." };
    }
  });
  if (process.env.NAVORI_PI_CHILD_DEPTH) return;
  pi.on("before_agent_start", async (event, ctx) => {
    if (!controls(ctx.cwd).masterPlan) return;
    try {
      const result = await pi.exec("navori", ["master", "status", "--line"], { cwd: ctx.cwd, timeout: 10_000 });
      const line = result.stdout.trim();
      if (result.code === 0 && line && !/[\r\n]/.test(line) && line.length <= 600) {
        return { systemPrompt: event.systemPrompt + "\n\n" + line };
      }
    } catch { /* Advisory only; the user's prompt must continue. */ }
  });
  let active = 0;
  pi.registerTool(defineTool({
    name: "navori_subagent",
    label: "Navori subagent",
    description: "Run a bounded Navori scout, implementer, or reviewer child in this trusted project.",
    parameters: Type.Object({ role: Type.Union([Type.Literal("scout"), Type.Literal("implementer"), Type.Literal("reviewer")]),
      task: Type.String({ minLength: 1 }), feature: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      assertTrustedPiParent(ctx);
      if (!ROLES.has(params.role)) throw new Error("Unsupported Navori Pi role");
      if (active >= MAX_CHILDREN) throw new Error("Navori Pi child concurrency limit reached (3)");
      const spec = roleSpec(ctx.cwd, params.role);
      active++;
      try {
        if (params.role !== "scout") await checkDispatch(ctx.cwd, params.role, params.task, params.feature, signal);
        const result = await runChild(ctx.cwd, spec, params.task, signal);
        return { content: [{ type: "text", text: result }], details: { role: params.role, truncated: result.length >= MAX_OUTPUT_BYTES } };
      } finally { active--; }
    },
  }));
}
