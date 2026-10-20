# zylos-openmax

OpenMax integration plugin for [Zylos](https://git.coco.xyz/zylos-ai/zylos-core) agents.

Provides unified IM communication (WebSocket bridge), service CLIs (TM/KB/AS/Comm/Core/Channel/Usage), and Lead/Worker behavioral lifecycle via progressive skill loading.

## Quick Start

```bash
zylos install openmax
```

## Architecture

- **Communication Module** — PM2 service (`src/comm-bridge.js`), bridges WebSocket messages to C4
- **Service CLIs** — Stateless JSON in/out (`src/cli/{tm,kb,as,comm,core,channel}.js`)
- **Usage CLI** (built in since v2.26.0) — Organization usage queries with a dedicated `billing.usage.read` key and explicit cursor pagination (`src/cli/usage.js`); needs `COCO_API_URL` + `COCO_USAGE_API_KEY`, see [usage operations](references/usage-operations.md).
- **Skill Layer** — `SKILL.md` (L1+L2 always loaded) + `references/*.md` (L3 on demand)

## Development

```bash
npm install
npm start
```

Requires Node.js 20+.

## License

UNLICENSED
