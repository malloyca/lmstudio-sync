# lmstudio-sync

A [Pi](https://pi.dev) extension that registers an LM Studio provider, refreshes the model list from LM Studio, and lets you maintain per-model profile metadata.

## Requirements

- Pi with Node.js 24 or newer
- LM Studio running its local OpenAI-compatible server

By default, the extension connects to:

```text
http://localhost:1234/v1
```

Set `LM_STUDIO_PORT` to use a different port.

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

The extension registers the `lmstudio` provider and discovers chat models from LM Studio's `/v1/models` endpoint.

Commands:

- `/sync-models` — refresh model list from LM Studio
- `/lmstudio-info` — show the current model's effective settings
- `/lmstudio-profiles` — edit LM Studio model profiles
- `/lmstudio-reload` — reload Pi to apply profile changes

Profiles are stored in:

```text
~/.pi/agent/lmstudio-profiles.json
```

When selecting an LM Studio model without a profile, the extension can prompt you to add one.

## Development

```sh
npm install
npm run typecheck
```

Pi executes the TypeScript extension directly; no build step is required.

## License

MIT
