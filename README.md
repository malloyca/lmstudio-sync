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

Edit this file, or use `/lmstudio-endpoints`, to add Tailscale or other LM Studio endpoints. Each endpoint gets a provider name such as `local/lmstudio` or `m3max/lmstudio`. `LM_STUDIO_PORT` is honored only when creating the initial local configuration.

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

## Development

```sh
npm install
npm run typecheck
```

Pi executes the TypeScript extension directly; no build step is required.

## License

MIT
