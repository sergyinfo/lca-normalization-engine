/**
 * Provider-agnostic LLM interface for per-page summary generation.
 *
 * The summary script and the runtime app both go through this interface so
 * we can swap providers (Anthropic / OpenAI / local vLLM) by changing one
 * env var. New providers just implement `LlmProvider` and register in
 * `getProvider()`.
 *
 * Configuration via env:
 *   LLM_PROVIDER=anthropic|openai|local|stub   (default: stub)
 *   LLM_MODEL=<provider-specific model name>
 *   LLM_API_KEY=<key>                          (anthropic / openai)
 *   LLM_BASE_URL=<endpoint>                    (local / openai-compatible)
 *
 * All providers return markdown; the page renders it with a markdown
 * component. Generation happens offline during the quarterly rebuild — the
 * runtime app only reads the cached summary from SQLite.
 */

export interface LlmRequest {
  /** A short system-style instruction describing the task + voice. */
  system: string;
  /** The structured-data payload the model should turn into prose. */
  user: string;
  /** Max output tokens. Defaults are provider-tuned. */
  maxTokens?: number;
  /** Sampling temperature. 0.3 default for editorial copy. */
  temperature?: number;
}

export interface LlmResponse {
  text: string;        // markdown
  model: string;       // model identifier, stored in entity_summary.model
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmProvider {
  readonly name: string;
  generate(req: LlmRequest): Promise<LlmResponse>;
}

/** Pick a provider from LLM_PROVIDER. Throws only when actually called. */
export async function getProvider(): Promise<LlmProvider> {
  const name = (process.env.LLM_PROVIDER ?? 'stub').toLowerCase();
  switch (name) {
    case 'anthropic': {
      const mod = await import('./anthropic');
      return mod.createAnthropicProvider();
    }
    case 'openai': {
      const mod = await import('./openai');
      return mod.createOpenAiProvider();
    }
    case 'local': {
      const mod = await import('./local');
      return mod.createLocalProvider();
    }
    case 'stub':
    default: {
      const mod = await import('./stub');
      return mod.createStubProvider();
    }
  }
}
