import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

test("oMLX registration, refresh, picker, runtime isolation, and endpoint commands", async () => {
  const home = await mkdtemp(join(tmpdir(), "omlx-integration-"));
  try {
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--experimental-transform-types",
      new URL("./fixtures/omlx-integration.ts", import.meta.url).pathname,
    ], { env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") }, timeout: 30_000 });
    assert.match(stdout, /oMLX integration checks passed/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
