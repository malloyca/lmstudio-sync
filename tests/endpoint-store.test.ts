import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_OMLX_ENDPOINTS, endpointProviderId } from "../extensions/lmstudio-sync/config.ts";
import { loadEndpointConfig } from "../extensions/lmstudio-sync/endpoint-store.ts";

test("oMLX defaults use the requested name, URL, and distinct provider ID", () => {
  assert.equal(endpointProviderId("local"), "local/lmstudio");
  assert.equal(endpointProviderId("local", "omlx"), "local/omlx");
  assert.deepEqual(DEFAULT_OMLX_ENDPOINTS, {
    local: { name: "Local oMLX", baseUrl: "http://localhost:8000/v1" },
  });
});

test("endpoint store creates defaults but preserves existing, disabled, and invalid files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omlx-endpoints-"));
  const path = join(dir, "omlx-endpoints.json");
  try {
    assert.deepEqual(await loadEndpointConfig(path, DEFAULT_OMLX_ENDPOINTS), DEFAULT_OMLX_ENDPOINTS);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), DEFAULT_OMLX_ENDPOINTS);
    const existing = { local: { name: "Custom", baseUrl: "http://localhost:9000/v1", enabled: false } };
    await writeFile(path, JSON.stringify(existing));
    assert.deepEqual(await loadEndpointConfig(path, DEFAULT_OMLX_ENDPOINTS), existing);
    assert.equal(await readFile(path, "utf8"), JSON.stringify(existing));

    for (const invalid of ["broken JSON", '{"local":{}}']) {
      await writeFile(path, invalid);
      await assert.rejects(loadEndpointConfig(path, DEFAULT_OMLX_ENDPOINTS));
      assert.equal(await readFile(path, "utf8"), invalid);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
