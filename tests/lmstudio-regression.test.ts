import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

test("LM Studio selection survives Pi's real registration/cache refresh lifecycle", async () => {
  const home = await mkdtemp(join(tmpdir(), "lmstudio-regression-"));
  const agentDir = join(home, ".pi", "agent");
  try {
    await mkdir(agentDir, { recursive: true });
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--experimental-transform-types",
      new URL("./fixtures/lmstudio-regression.ts", import.meta.url).pathname,
    ], { env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, timeout: 30_000 });
    assert.match(stdout, /LM Studio real-registry regression checks passed/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
