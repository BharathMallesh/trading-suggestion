// OpenRouter (OpenAI-compatible) connection details for the trading-research
// module. These MIRROR the app's "ling-fin" preset in
// src/agent-core/providers.ts, but are duplicated here on purpose: this module
// is self-contained and never imports from the app build, so the two can be
// maintained independently.
export const OPENROUTER = {
  baseUrl: 'https://openrouter.ai/api/v1',
  // Finance-tuned Ling model (256K context). Override with LING_MODEL if needed.
  model: process.env.LING_MODEL || 'inclusionai/ling-3.0-flash-fin',
  // The API key is read from the environment — never hard-code it here.
  apiKeyEnv: 'OPENROUTER_API_KEY',
};
