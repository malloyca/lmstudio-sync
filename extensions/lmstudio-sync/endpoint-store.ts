import { readFile, writeFile } from "node:fs/promises";
import { validateEndpointConfig } from "./config.ts";
import type { EndpointConfig } from "./config.ts";

/** Preserve existing endpoint settings; write defaults only on first use. */
export async function loadEndpointConfig(
  path: string,
  defaults: EndpointConfig,
  validate: (value: unknown) => EndpointConfig = validateEndpointConfig,
): Promise<EndpointConfig> {
  try {
    const raw = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Endpoint configuration must be valid JSON");
    }
    return validate(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const initial = validate(defaults);
  await writeFile(path, JSON.stringify(initial, null, 2) + "\n");
  return initial;
}
