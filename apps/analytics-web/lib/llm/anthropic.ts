/**
 * Anthropic provider — calls the Messages API directly via fetch so we
 * don't add an SDK dependency just for ~500 calls a quarter.
 *
 * Configure via env:
 *   LLM_API_KEY=sk-ant-...
 *   LLM_MODEL=claude-sonnet-4-6        (default)
 */

import type { LlmProvider, LlmRequest, LlmResponse } from './provider';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

export function createAnthropicProvider(): LlmProvider {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error('LLM_API_KEY missing; required for LLM_PROVIDER=anthropic');
  }
  const model = process.env.LLM_MODEL ?? DEFAULT_MODEL;

  return {
    name: 'anthropic',
    async generate(req: LlmRequest): Promise<LlmResponse> {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? 600,
          temperature: req.temperature ?? 0.3,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
        }),
      });
      if (!res.ok) {
        throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
      }
      const j = await res.json() as {
        content: Array<{ type: string; text: string }>;
        model: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = j.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
        .trim();
      return {
        text,
        model: j.model,
        inputTokens: j.usage?.input_tokens,
        outputTokens: j.usage?.output_tokens,
      };
    },
  };
}
