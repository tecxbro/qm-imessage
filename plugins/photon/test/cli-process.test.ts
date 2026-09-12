import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PhotonCliProcess,
  PhotonCliProcessError,
  photonCliArgv,
  type PhotonCliInvocation,
} from "../src/setup/cli-process.ts";
import { PhotonDeviceAuthorizationParser } from "../src/setup/device-login.ts";

async function fixture(t: test.TestContext, body: string): Promise<{ executable: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "qm-photon-cli-"));
  const executable = join(root, "photon-fixture.mjs");
  await writeFile(executable, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return { executable, root };
}

function processFor(root: string, executable: string, options: { timeoutMs?: number; outputBytes?: number } = {}) {
  return new PhotonCliProcess({
    configRoot: join(root, "config"),
    executable,
    ...(options.timeoutMs === undefined ? {} : { defaultTimeoutMs: options.timeoutMs }),
    ...(options.outputBytes === undefined ? {} : { defaultMaxOutputBytes: options.outputBytes }),
  });
}

test("allowlisted argv uses the installed 2.2.0 command forms and excludes mutations", () => {
  const invocations: PhotonCliInvocation[] = [
    { command: "version" },
    { command: "login" },
    { command: "whoami" },
    { command: "projects-list" },
    { command: "project-show", projectId: "project-a" },
    { command: "project-secret", projectId: "project-a" },
    { command: "project-create", name: "QM iMessage" },
    { command: "users-list", projectId: "project-a" },
    { command: "lines-list", projectId: "project-a" },
  ];
  const argv = invocations.map(photonCliArgv);
  assert.deepEqual(argv[1], ["login", "--no-browser"]);
  assert.deepEqual(argv[3], ["projects", "ls", "--json"]);
  assert.deepEqual(argv[6], [
    "projects",
    "create",
    "--name",
    "QM iMessage",
    "--location",
    "United States",
    "--platforms",
    "imessage",
    "--json",
  ]);
  const flattened = argv.flat().join(" ");
  assert.doesNotMatch(flattened, /regenerate|billing|upgrade|delete|remove|--token/u);
});

test("process boundary uses literal argv, isolated environment, and private modes", async (t) => {
  const { executable, root } = await fixture(
    t,
    `import { mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
mkdirSync(process.env.PHOTON_CONFIG_DIR + "/credentials", { recursive: true, mode: 0o777 });
writeFileSync(process.env.PHOTON_CONFIG_DIR + "/credentials/production.json", "private", { mode: 0o666 });
process.stdout.write(JSON.stringify({ args, config: process.env.PHOTON_CONFIG_DIR, token: process.env.PHOTON_TOKEN, secret: process.env.SPECTRUM_PROJECT_SECRET }));`,
  );
  const cli = processFor(root, executable);
  const priorToken = process.env.PHOTON_TOKEN;
  const priorSecret = process.env.SPECTRUM_PROJECT_SECRET;
  process.env.PHOTON_TOKEN = "management-secret";
  process.env.SPECTRUM_PROJECT_SECRET = "runtime-secret";
  try {
    const result = await cli.run("installation-a", {
      command: "project-create",
      name: "literal $(touch shell-expanded)",
    });
    const observed = JSON.parse(result.stdout) as {
      args: string[];
      config: string;
      token?: string;
      secret?: string;
    };
    assert.deepEqual(observed.args, [
      "projects",
      "create",
      "--name",
      "literal $(touch shell-expanded)",
      "--location",
      "United States",
      "--platforms",
      "imessage",
      "--json",
    ]);
    assert.equal(observed.token, undefined);
    assert.equal(observed.secret, undefined);
    await assert.rejects(stat(join(observed.config, "shell-expanded")), { code: "ENOENT" });
    assert.equal((await stat(observed.config)).mode & 0o777, 0o700);
    assert.equal((await stat(join(observed.config, "credentials"))).mode & 0o777, 0o700);
    assert.equal((await stat(join(observed.config, "credentials", "production.json"))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(observed.config, "credentials", "production.json"), "utf8"), "private");
  } finally {
    if (priorToken === undefined) delete process.env.PHOTON_TOKEN;
    else process.env.PHOTON_TOKEN = priorToken;
    if (priorSecret === undefined) delete process.env.SPECTRUM_PROJECT_SECRET;
    else process.env.SPECTRUM_PROJECT_SECRET = priorSecret;
  }
});

test("each installation receives a distinct config directory", async (t) => {
  const { executable, root } = await fixture(t, `process.stdout.write("2.2.0\\n");`);
  const cli = processFor(root, executable);
  assert.notEqual(cli.configDirectory("installation-a"), cli.configDirectory("installation-b"));
  assert.equal(await cli.verifyVersion("installation-a"), "2.2.0");
});

test("unsupported installed version fails closed", async (t) => {
  const { executable, root } = await fixture(t, `process.stdout.write("2.3.0\\n");`);
  const cli = processFor(root, executable);
  await assert.rejects(cli.verifyVersion("installation-a"), (error: unknown) => {
    return error instanceof PhotonCliProcessError && error.code === "unsupported-version";
  });
});

test("output is bounded", async (t) => {
  const { executable, root } = await fixture(t, `process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000);`);
  const cli = processFor(root, executable, { outputBytes: 64 });
  await assert.rejects(cli.run("installation-a", { command: "projects-list" }), (error: unknown) => {
    return error instanceof PhotonCliProcessError && error.code === "output-limit";
  });
});

test("timeout and cancellation terminate the child", async (t) => {
  const { executable, root } = await fixture(t, `setInterval(() => {}, 1000);`);
  const timed = processFor(root, executable, { timeoutMs: 25 });
  await assert.rejects(timed.run("installation-a", { command: "projects-list" }), (error: unknown) => {
    return error instanceof PhotonCliProcessError && error.code === "timeout";
  });
  const cancelled = processFor(root, executable, { timeoutMs: 5_000 });
  const controller = new AbortController();
  const running = cancelled.run("installation-b", { command: "projects-list" }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(running, (error: unknown) => {
    return error instanceof PhotonCliProcessError && error.code === "cancelled";
  });
});

test("private CLI output is reduced to a safe failure code", async (t) => {
  const { executable, root } = await fixture(
    t,
    `process.stderr.write("Authorization was denied. raw-token=private-value\\n"); process.exit(1);`,
  );
  const cli = processFor(root, executable);
  await assert.rejects(cli.run("installation-a", { command: "login" }), (error: unknown) => {
    assert.ok(error instanceof PhotonCliProcessError);
    assert.equal(error.message, "authorization-denied");
    assert.doesNotMatch(error.message, /private-value/u);
    return true;
  });
});

test("authorization parser tolerates arbitrary chunk and ANSI boundaries", () => {
  const parser = new PhotonDeviceAuthorizationParser();
  const output =
    "\u001b[2m  Visit:\u001b[0m \u001b[4m\u001b[36mhttps://app.photon.codes/device?code=ABCD-EFGH\u001b[0m\n  \u001b[2mCode: \u001b[0m \u001b[1mABCD-EFGH\u001b[0m\n";
  let authorization;
  for (const character of output) authorization = parser.feed(character) ?? authorization;
  assert.deepEqual(authorization, {
    userCode: "ABCD-EFGH",
    verificationUrl: "https://app.photon.codes/device?code=ABCD-EFGH",
  });
  assert.deepEqual(parser.finish(), authorization);
});

test("authorization parser rejects untrusted and malformed output", () => {
  const parser = new PhotonDeviceAuthorizationParser();
  assert.equal(parser.feed("Visit: https://attacker.example/device\nCode: PRIVATE-CODE\n"), undefined);
  assert.throws(() => parser.finish(), PhotonCliProcessError);
});
