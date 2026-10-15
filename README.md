# zylos-openmax

OpenMax integration plugin for [Zylos](https://git.coco.xyz/zylos-ai/zylos-core) agents.

Provides unified IM communication (WebSocket bridge), service CLIs (TM/KB/AS/Comm/Core), and Lead/Worker behavioral lifecycle via progressive skill loading.

## Quick Start

```bash
zylos install openmax
```

## Architecture

- **Communication Module** — PM2 service (`src/comm-bridge.js`), bridges WebSocket messages to C4
- **Service CLIs** — Stateless JSON in/out (`src/cli/{tm,kb,as,comm,core}.js`)
- **Usage CLI (Draft)** — Dedicated-key usage queries and explicit cursor pagination (`src/cli/usage.js`); see [usage operations](references/usage-operations.md) for dependencies and credential setup.
- **Skill Layer** — `SKILL.md` (L1+L2 always loaded) + `references/*.md` (L3 on demand)

## Development

```bash
npm install
npm start
```

Requires Node.js 20+.

## License

UNLICENSED
