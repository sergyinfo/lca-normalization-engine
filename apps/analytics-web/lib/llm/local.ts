/**
 * Local provider — convenience wrapper around the OpenAI-compatible client
 * pointed at a self-hosted vLLM / Ollama / TGI instance.
 *
 * Same wire format as ./openai.ts; this just provides better defaults so
 * `LLM_PROVIDER=local` works out of the box once you have vLLM running on
 * localhost:8000 (or set LLM_BASE_URL to a remote endpoint).
 *
 * If you're running Stage 3 LLM on a rented GPU box (see the root README's
 * "Mode 3" section), pointing this at the ngrok URL reuses that infra for
 * summary generation at zero marginal API cost.
 *
 *   LLM_PROVIDER=local
 *   LLM_BASE_URL=https://abc123.ngrok-free.app/v1
 *   LLM_MODEL=meta-llama/Llama-3.1-8B-Instruct
 *   LLM_API_KEY=<the vLLM --api-key value>
 */

import { createOpenAiProvider } from './openai';
import type { LlmProvider } from './provider';

export function createLocalProvider(): LlmProvider {
  process.env.LLM_BASE_URL ??= 'http://localhost:8000/v1';
  process.env.LLM_MODEL    ??= 'meta-llama/Llama-3.1-8B-Instruct';
  process.env.LLM_API_KEY  ??= 'unused';   // vLLM accepts any token if --api-key wasn't set
  const inner = createOpenAiProvider();
  return { ...inner, name: 'local' };
}
