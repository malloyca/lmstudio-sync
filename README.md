# lmstudio-sync

A [Pi](https://pi.dev) extension that registers providers for LM Studio and oMLX endpoints, refreshes model lists, and lets you maintain LM Studio endpoint-specific profile metadata.

## Requirements

- Pi 1.5 or newer with Node.js 24 or newer
- LM Studio or oMLX running its local OpenAI-compatible server

On first run, the extension creates an endpoint configuration at:

```text
~/.pi/agent/lmstudio-endpoints.json
```

It initially contains the local endpoint:

```json
{
  "local": {
    "name": "Local LM Studio",
    "baseUrl": "http://localhost:1234/v1"
  }
}
```

Edit this file, or use `/lmstudio-endpoints`, to add Tailscale or other LM Studio endpoints. Each endpoint gets a provider name such as `local/lmstudio` or `m3max/lmstudio`. Use `/lmstudio-toggle-endpoint` to enable or disable a configured endpoint without editing JSON; disabled endpoints are retained in the config but omitted from discovery and model selection. The optional `enabled` property defaults to `true`. `LM_STUDIO_PORT` is honored only when creating the initial local configuration.

Shared discovery excludes model IDs containing `dflash2` (case-insensitive) from every endpoint, including LM Studio and oMLX, because these draft checkpoints are not standalone chat models. The exclusion applies to both automatic refreshes and `/sync-models`/`/set-model-from-provider`, so they do not enter this extension's Pi `/model` catalogs either. This is an explicit naming-based exclusion, not general draft-model detection. It does not delete models, remove saved profiles, or prevent an inference engine from using them internally for speculative decoding.

### Local oMLX

On first run, the extension also creates `~/.pi/agent/omlx-endpoints.json`:

```json
{
  "local": {
    "name": "Local oMLX",
    "baseUrl": "http://localhost:8000/v1"
  }
}
```

This registers **`local/omlx`**, independently of **`local/lmstudio`**. Existing LM Studio configuration is preserved. Both engines appear in `/set-model-from-provider`, including offline endpoints, and both are refreshed by `/sync-models` and Pi's provider model refresh.

Use `/omlx-endpoints` to edit oMLX URLs and `/omlx-toggle-endpoint` to enable or disable them. Disabled endpoints are not queried. The endpoint ID `local` is scoped to its engine, so it can appear in both configuration files.

Discovery uses `/v1/models`, excludes explicit non-chat model types, and retains model aliases and exposed profile IDs returned by oMLX. Pi's model capabilities and token limits currently use this extension's guessed defaults; LM Studio's saved model profiles do not apply to oMLX. Configure oMLX loading, context, and other server-side settings in oMLX itself. The extension never calls LM Studio's native load/unload APIs for an oMLX model.

### oMLX authentication and security

1. Enable API-key authentication in oMLX.
2. In Pi, run `/login`, select **Local oMLX** (`local/omlx`), and enter the key in Pi's secret-input prompt.
3. Run `/sync-models` or `/set-model-from-provider` to refresh and select a model.

Each oMLX provider has its own Pi-managed credential. Additional endpoint `office` uses `office/omlx` and requires its own login. `/logout` removes the credential from Pi; revoke or rotate it in oMLX as well if needed. No dummy key or automatic environment-variable fallback is used. Missing credentials, rejected credentials, redirects, and offline servers have distinct status labels.

The extension uses Pi's authentication APIs for discovery and inference and does not read or write `auth.json` itself. Pi stores the key in its agent directory's `auth.json`, alongside non-secret endpoint-binding metadata. This file is **not encrypted**; keep it private, outside repositories, backups/shared folders without appropriate protection, tool-visible mounts, and untrusted process environments.

Keys are bound to the exact configured base URL, including its path. A URL change requires a new `/login`; an old or manually inserted credential without endpoint-binding metadata is not used. oMLX endpoint JSON accepts only `name`, `baseUrl`, and `enabled`, never a raw key or authorization header. URLs containing credentials, query parameters, or fragments are rejected. Use **HTTPS** for non-loopback endpoints, or forward the server through a local encrypted tunnel. Plain HTTP is allowed only for loopback addresses.

Authenticated requests are restricted to the configured model-list and chat-completions URLs, use Bearer headers, and never follow redirects. The extension discards HTTP error bodies and sanitizes transport and terminal inference errors rather than placing raw server errors in Pi sessions. Live catalogs are kept in memory, without credentials or persisted server payloads.

These protections do not isolate credentials from Pi itself, other extensions in its process, a compromised inference server, or tools running with access to Pi's host files/processes. With host Pi plus sandboxed tools, keep `auth.json` unmounted and do not forward credentials into the sandbox. Pi's credential storage is not an OS Keychain.

Pi normally runs on the host, so `localhost` refers to your Mac. For Pi running inside a container, use a local tunnel or a trusted HTTPS endpoint; the HTTP alias `host.docker.internal` is intentionally not treated as loopback.

## Install

Install directly from GitHub:

```sh
pi install git:github.com/<owner>/lmstudio-sync
```

Or install from a local checkout:

```sh
pi install /absolute/path/to/lmstudio-sync
```

Restart Pi after installation. Confirm the package is registered with:

```sh
pi list
```

To try it for one Pi process without installing it:

```sh
pi -e /absolute/path/to/lmstudio-sync
```

## Usage

The extension registers one provider per configured LM Studio or oMLX endpoint and discovers chat models from each endpoint's `/v1/models` endpoint. Unavailable endpoints contribute no models until the next refresh.

Commands:

- `/sync-models` — refresh model lists from all LM Studio and oMLX endpoints
- `/set-model-from-provider` — choose a configured local-engine endpoint or an authenticated provider, then choose a model
- `/omlx-endpoints` — edit oMLX endpoint configuration
- `/omlx-toggle-endpoint` — enable or disable an oMLX endpoint
- `/lmstudio-endpoints` — edit LM Studio endpoint configuration
- `/lmstudio-toggle-endpoint` — enable or disable an endpoint
- `/model-info` — toggle the current model's brief settings widget
- `/model-info-full` — show the current model's full settings in a scrollable overlay
- `/lmstudio-profiles` — edit LM Studio model profiles
- `/lmstudio-reload` — refresh LM Studio profiles and model catalogs

LM Studio model profiles are stored in:

```text
~/.pi/agent/lmstudio-profiles.json
```

New profiles are scoped by endpoint:

```json
{
  "m3max": {
    "qwen/qwen3-8b": {
      "contextWindow": 131072
    }
  }
}
```

Profiles must be scoped by endpoint. When selecting an LM Studio model without a profile, the extension can prompt you to add one.

### Profile context and LM Studio runtime

A profile's `contextWindow` is used as the minimum context capacity Pi advertises for that model and the requested context when LM Studio loads it. For example, the profile above requests a `131072`-token LM Studio runtime for `m3max/qwen3-8b`.

Runtime capacity follows a **high-water policy** across Pi sessions sharing an endpoint: if the loaded instance already has at least the profile's requested context, it is reused; if not, the extension reloads it at the larger requested size. It never automatically downsizes a loaded instance when a smaller profile is selected. The extension checks LM Studio's reported maximum before loading and warns without changing the runtime if the request is too large. Multiple loaded instances of the same model are left untouched because the native API does not provide reliable instance routing for this adjustment.

Changing a loaded model's context requires unloading and reloading it. This can interrupt requests currently using that shared LM Studio instance, so avoid changing profiles or selecting a larger-context profile while another Pi session is generating with the same model. Separate Pi sessions can use the shared instance sequentially; their conversation histories remain separate.

`contextWindow` is Pi's context/compaction setting, not a strict hard token cap on the conversation. Pi's default compaction settings reserve `16384` tokens and keep `20000` recent tokens; for small model context windows these values can exceed the profile window, so Pi may temporarily retain more conversation context than the profile value. In particular, windows below `20000` are not strictly bounded by the default retention setting. This extension does not modify Pi's compaction settings. For typical profiles of `65536` tokens or more, the default retained history fits within the window, but compaction behavior still depends on Pi's settings and token accounting.

## Development

```sh
npm install
npm run typecheck
npm test
```

Pi executes the TypeScript extension directly; no build step is required. Configuration follows Pi's agent directory, including `PI_CODING_AGENT_DIR` when set.

To test the development copy on the host without loading the installed copy:

```sh
pi --no-extensions --no-tools -e /absolute/path/to/lmstudio-sync
```

The `--no-tools` flag is intentional: disabling other extensions also disables any sandbox integration they provide. Keep model-callable tools off for this host-side smoke test. This does not install the checkout or change which package is configured globally. It still uses your usual Pi credentials and endpoint files. For fully isolated testing, create a private directory outside the project and set `PI_CODING_AGENT_DIR` to it for this invocation; log in separately and remove that directory when finished. Never place test credentials under the sandbox-mounted workspace.

## License

MIT
