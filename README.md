# lmstudio-sync

A [Pi](https://pi.dev) extension that registers one provider per LM Studio endpoint, refreshes model lists, and lets you maintain endpoint-specific profile metadata.

## Requirements

- Pi with Node.js 24 or newer
- LM Studio running its local OpenAI-compatible server

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

The extension registers one provider per configured endpoint and discovers chat models from each endpoint's `/v1/models` endpoint. Unavailable endpoints contribute no models until the next refresh.

Commands:

- `/sync-models` — refresh model lists from all LM Studio endpoints
- `/set-model-from-provider` — choose a configured LM Studio endpoint or an authenticated provider, then choose a model
- `/lmstudio-endpoints` — edit LM Studio endpoint configuration
- `/lmstudio-toggle-endpoint` — enable or disable an endpoint
- `/model-info` — toggle the current model's brief settings widget
- `/model-info-full` — show the current model's full settings in a scrollable overlay
- `/lmstudio-profiles` — edit LM Studio model profiles
- `/lmstudio-reload` — refresh LM Studio profiles and model catalogs

Profiles are stored in:

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

Pi executes the TypeScript extension directly; no build step is required.

## License

MIT
