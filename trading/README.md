# Trading research module

An **isolated, self-contained** module for finance **research and analysis**,
kept separate from the main app so the two can evolve independently — nothing
here imports from the app build, and changing the app never requires changing
this folder (or vice-versa). It reuses the same OpenRouter / **Ling 3.0 Flash
Fin** connection the app uses.

## Scope — read this first

This module is **information only**. It deliberately does **not**:

- ❌ predict prices or market direction ("will X go up or down")
- ❌ give buy / sell / hold recommendations, entry/exit points, or price targets
- ❌ give personalized investment advice
- ❌ connect to a brokerage, place orders, or move money

It **does**:

- ✅ explain instruments, metrics, and how to read them
- ✅ summarize and structure factual context you provide or ask about
- ✅ lay out drivers and risks so **you** can form your own view

Why the limits: no model — finance-tuned or not — can reliably forecast prices,
and executing trades / giving personalized advice is a licensed, high-risk
activity. Decision-support, never decision-making. The guardrails are enforced
in the model's system prompt (`research.mjs`), but they are policy, not a
technical guarantee — treat every output as general information.

## Setup

Uses Node's built-in `fetch` (Node 18+), no dependencies to install.

```bash
export OPENROUTER_API_KEY="sk-or-..."     # your own OpenRouter key
```

Optional: `export LING_MODEL="inclusionai/ling-3.0-flash"` to use a different
OpenRouter model.

## Use

CLI:

```bash
node trading/research.mjs "Explain HDFC Bank's net interest margin and what moves it"
```

Or as a library:

```js
import { research } from './trading/research.mjs';
const answer = await research('What is a candlestick chart and how is it read?');
```

## Files

- `config.mjs` — OpenRouter base URL + model (mirrors the app's `ling-fin` preset).
- `ling-client.mjs` — minimal OpenAI-compatible client (key from `OPENROUTER_API_KEY`).
- `research.mjs` — the guardrailed research entry point (library + CLI).
