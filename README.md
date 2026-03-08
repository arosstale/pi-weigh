# @artale/pi-weigh

Token burden analysis for pi. See exactly what's consuming your context window.

Replaces the broken `pi-token-burden` package (protobufjs crash on Windows).

## Install
```bash
npm install -g @artale/pi-weigh
```

## Features (v1.1)
- **System prompt breakdown** — Core instructions, tool descriptions, project context, skill catalog
- **Per-tool token cost** — Every tool ranked by weight with source attribution
- **Per-skill token cost** — Skill catalog entries ranked by size
- **Deactivation candidates** — Tools >200 tokens that could be disabled, with savings estimate
- **History tracking** — Token burden snapshots over time with trend indicators
- **HTML report** — Auto-opens detailed visual report in browser
- **Machine-readable** — `weigh` tool returns structured JSON for agents

## Tools
- **weigh** — Get token burden breakdown (JSON)

## Commands
- `/weigh` — Generate HTML report + terminal summary
