/**
 * OpenAI (or OpenAI-compatible) provider — single fetch to /v1/chat/completions.
 * Works with the actual OpenAI API and with any OpenAI-compatible server
 * (vLLM, Ollama, OpenRouter, Together).
 *
 * Configure via env:
 *   LLM_API_KEY=sk-...
 *   LLM_MODEL=gpt-4o-mini          (default)
 *   LLM_BASE_URL=https://api.openai.com/v1   (default)
 */

import type { LlmProvider, LlmRequest, LlmResponse } from './provider';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE  = 'https://api.openai.com/v1';

export function createOpenAiProvider(): LlmProvider {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error('LLM_API_KEY missing; required for LLM_PROVIDER=openai');
  }
  const model   = process.env.LLM_MODEL    ?? DEFAULT_MODEL;
  const baseUrl = process.env.LLM_BASE_URL ?? DEFAULT_BASE;

  return {
    name: 'openai',
    async generate(req: LlmRequest): Promise<LlmResponse> {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? 600,
          temperature: req.temperature ?? 0.3,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user',   content: req.user   },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
      }
      const j = await res.json() as {
        choices: Array<{ message: { content: string } }>;
        model: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: (j.choices[0]?.message.content ?? '').trim(),
        model: j.model,
        inputTokens: j.usage?.prompt_tokens,
        outputTokens: j.usage?.completion_tokens,
      };
    },
  };
}
