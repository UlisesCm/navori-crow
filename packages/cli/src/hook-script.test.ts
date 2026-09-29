import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateHookScript } from "./hook-script";

const root = mkdtempSync(join(tmpdir(), "crow-hook-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Run {
  code: number | null;
  stdout: string;
  ms: number;
}

async function runScript(
  port: number,
  opts: { path?: string; token?: string; tmp?: string; onStart?: () => Promise<void> } = {},
): Promise<Run> {
  const home = mkdtempSync(join(root, "home-"));
  if (opts.token) writeFileSync(join(home, "token"), `${opts.token}\n`);
  const script = join(home, "crow-ingest-hook");
  writeFileSync(script, generateHookScript({ crowHome: home, port }));
  chmodSync(script, 0o700);
  const start = performance.now();
  const proc = Bun.spawn(["/bin/sh", script, "claude"], {
    stdin: new Blob(['{"hook_event_name":"Stop"}']),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: opts.path ?? process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: home,
      ...(opts.tmp ? { TMPDIR: opts.tmp } : {}),
    },
  });
  await opts.onStart?.();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  expect(stderr).toBe("");
  return { code, stdout, ms: performance.now() - start };
}

let seenAuth: string | null = null;
let seenPath = "";
let seenBody = "";
const servers: Array<ReturnType<typeof Bun.serve>> = [];
function serve(handler: (req: Request) => Response | Promise<Response>): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  servers.push(s);
  return s.port ?? 0;
}

let closedPort = 0;
let hungPort = 0;
let p401 = 0;
let p413 = 0;
let okPort = 0;

beforeAll(() => {
  const tmp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  closedPort = tmp.port ?? 0;
  void tmp.stop(true);
  hungPort = serve(() => new Promise<Response>(() => {}));
  p401 = serve(() => new Response("no", { status: 401 }));
  p413 = serve(() => new Response("big", { status: 413 }));
  okPort = serve(async (req) => {
    seenAuth = req.headers.get("authorization");
    seenPath = new URL(req.url).pathname;
    seenBody = await req.text();
    return new Response(null, { status: 204 });
  });
});
afterAll(() => {
  for (const s of servers) void s.stop(true);
});

describe("generated hook script is fail-open", () => {
  // Covers: R20
  test("port closed: exit 0, empty stdout, fast", async () => {
    const r = await runScript(closedPort);
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(r.ms).toBeLessThan(2200);
  });

  // Covers: R20
  test("hung server: exit 0, empty stdout, capped at 2 s", async () => {
    const r = await runScript(hungPort);
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(r.ms).toBeLessThan(2200);
  });

  // Covers: R20
  test("401 and 413: exit 0, empty stdout", async () => {
    for (const port of [p401, p413]) {
      const r = await runScript(port);
      expect(r).toMatchObject({ code: 0, stdout: "" });
      expect(r.ms).toBeLessThan(2200);
    }
  });

  // Covers: R20
  test("no curl on PATH: exit 0, empty stdout, empty stderr", async () => {
    const empty = join(root, "empty-bin");
    mkdirSync(empty, { recursive: true });
    const r = await runScript(okPort, { path: empty, token: "t" });
    expect(r).toMatchObject({ code: 0, stdout: "" });
  });

  // Covers: R20
  test("sends the payload to /ingest/hook/<engine> with the Bearer token from $CROW_HOME/token", async () => {
    const r = await runScript(okPort, { token: "sekret" });
    expect(r).toMatchObject({ code: 0, stdout: "" });
    expect(seenPath).toBe("/ingest/hook/claude");
    expect(seenAuth).toBe("Bearer sekret");
    expect(seenBody).toBe('{"hook_event_name":"Stop"}');
  });

  // Covers: R20
  test("no token file: no Authorization header", async () => {
    await runScript(okPort);
    expect(seenAuth).toBeNull();
  });

  // Covers: R20
  test("the token is never embedded in the script", () => {
    expect(generateHookScript({ crowHome: "/h", port: 7777 })).not.toContain("Bearer sekret");
  });

  // Covers: R20
  test("the token never shows in any process argv while curl hangs (ps)", async () => {
    const tmp = mkdtempSync(join(root, "tmp-"));
    const samples: string[] = [];
    const r = await runScript(hungPort, {
      token: "argv-canary-7f3a",
      tmp,
      onStart: async () => {
        for (let i = 0; i < 6; i++) {
          await Bun.sleep(150);
          const ps = Bun.spawnSync(["ps", "-axo", "args="]);
          samples.push(ps.stdout.toString());
        }
      },
    });
    expect(r.code).toBe(0);
    // Only this script's curl (it targets the hung port); other processes on the machine are noise.
    const curls = samples
      .join("\n")
      .split("\n")
      .filter((l) => l.includes("curl") && l.includes(`127.0.0.1:${hungPort}/`));
    expect(curls.length).toBeGreaterThan(0);
    expect(curls.join("\n")).not.toContain("argv-canary-7f3a");
  });

  // Covers: R20
  test("the temporary header file is removed on success and on the timeout path", async () => {
    for (const port of [okPort, hungPort]) {
      const tmp = mkdtempSync(join(root, "tmp-"));
      await runScript(port, { token: "t0k", tmp });
      expect(readdirSync(tmp)).toEqual([]);
    }
  });
});
