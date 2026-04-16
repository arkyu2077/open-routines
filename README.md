# Open Routines

Open Routines is the open routines layer for AI agents.

This monorepo contains the local-first MVP:

- `routines` CLI
- local daemon
- Open Routine Spec v1
- local schedule execution
- provider connection management
- GPT OAuth foundations

## Packages

- `@open-routines/core`
- `@open-routines/spec`
- `@open-routines/auth`
- `@open-routines/store`
- `@open-routines/providers`
- `@open-routines/runtime`
- `@open-routines/sdk`
- `@open-routines/daemon`
- `@open-routines/cli`

## Quick Start

```bash
pnpm install
pnpm build
routines start
```

Or without a global install:

```bash
node packages/cli/dist/bin/routines.js start
```

Then enable and run your first routine:

```bash
node packages/cli/dist/bin/routines.js routine enable examples/hello.yaml
node packages/cli/dist/bin/routines.js routine run hello-world
```

## Local Development

```bash
pnpm clean
pnpm build
pnpm test
pnpm smoke
pnpm verify
```

Useful shortcuts:

```bash
pnpm cli -- --help
pnpm cli -- start
pnpm daemon:once
```

## Example Routine

See [examples/hello.yaml](./examples/hello.yaml).

## GPT OAuth Setup

The GPT provider supports two local OAuth entry points:

- localhost browser callback
- device code

Before using them, configure these environment variables:

```bash
export OPEN_ROUTINES_GPT_CLIENT_ID="..."
export OPEN_ROUTINES_GPT_AUTHORIZATION_ENDPOINT="..."
export OPEN_ROUTINES_GPT_TOKEN_ENDPOINT="..."
export OPEN_ROUTINES_GPT_DEVICE_AUTHORIZATION_ENDPOINT="..."
export OPEN_ROUTINES_GPT_SCOPES="openid profile email"
```

You can still connect GPT directly with either:

```bash
node packages/cli/dist/bin/routines.js provider connect gpt --oauth local
node packages/cli/dist/bin/routines.js provider connect gpt --oauth device
```

## Custom Compatible Providers

You can register third-party providers that expose either an OpenAI-compatible
API or a Claude/Anthropic-compatible API.

```bash
node packages/cli/dist/bin/routines.js provider connect openrouter \
  --openai-base-url https://openrouter.ai/api/v1 \
  --api-key-env OPENROUTER_API_KEY
```

For Claude-compatible vendors:

```bash
node packages/cli/dist/bin/routines.js provider connect my-claude \
  --claude-base-url https://vendor.example.com/v1 \
  --api-key-env VENDOR_API_KEY
```

Then reference the custom provider id in your routine YAML:

```yaml
provider:
  type: openrouter
  model: openai/gpt-4.1-mini
```

If you need extra static headers:

```bash
node packages/cli/dist/bin/routines.js provider connect openrouter \
  --openai-base-url https://openrouter.ai/api/v1 \
  --api-key-env OPENROUTER_API_KEY \
  --header "HTTP-Referer=https://routines.one" \
  --header "X-Title=Open Routines"
```
