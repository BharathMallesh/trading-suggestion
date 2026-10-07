# Multi-agent layer (experimental)

Two specialized agents plus a coordinator for paper-trading research.

## Agents

| Agent | File | Role |
|-------|------|------|
| **Research** | `research-agent.mjs` | Factual overview, quote, candle stats. No price predictions. |
| **Signal** | `signal-agent.mjs` | LONG / SHORT / FLAT paper signals (tech-only or hybrid). |
| **Coordinator** | `coordinator.mjs` | Runs both → experimental paper brief + paper suggestions. |

## Disclaimers

- Experimental only.
- Paper simulation — no real orders.
- Not investment advice.
- Signals have no proven edge.

## Usage

### Via web UI

```bash
node server.mjs
# http://localhost:3000 → Paper-Bot → Run agents
```

### Via API

```bash
curl -X POST http://127.0.0.1:3000/api/agents \
  -H 'Content-Type: application/json' \
  -d '{
    "symbols": ["RELIANCE.NS", "TCS.NS"],
    "techOnly": true,
    "interval": "1d"
  }'
```

Individual agents:

```bash
# Research only
curl -X POST http://127.0.0.1:3000/api/agents/research \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"TCS.NS","question":"What are the main business segments?"}'

# Signal only
curl -X POST http://127.0.0.1:3000/api/agents/signal \
  -H 'Content-Type: application/json' \
  -d '{"symbols":["INFY.NS","HDFCBANK.NS"],"techOnly":true}'
```

### As a library

```js
import { runAgents } from './agents/coordinator.mjs';
import { researchAgent } from './agents/research-agent.mjs';
import { signalAgent } from './agents/signal-agent.mjs';

const brief = await runAgents({
  symbols: ['RELIANCE.NS', 'TCS.NS'],
  techOnly: true,
});

const research = await researchAgent({ symbol: 'TCS.NS' });
const signals = await signalAgent({ symbols: ['INFY.NS'], techOnly: true });
```

## Output shape (coordinator)

- `agents.research` — quote, description, factual answer
- `agents.signal` — list of signals
- `paper` — paper account snapshot
- `experimentalSuggestions` — paper-only LONG/SHORT ideas with stops/targets
- `disclaimers` — always present
