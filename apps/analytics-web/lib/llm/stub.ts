/**
 * Stub provider — no network calls. Generates a deterministic placeholder
 * summary from the data payload, useful for local dev / CI / first-launch
 * scaffolding before the real provider is wired up.
 *
 * The output is still valid markdown that the page renders normally.
 */

import type { LlmProvider, LlmRequest, LlmResponse } from './provider';

export function createStubProvider(): LlmProvider {
  return {
    name: 'stub',
    async generate(req: LlmRequest): Promise<LlmResponse> {
      const preview = req.user.slice(0, 200).replace(/\n+/g, ' ');
      const text = [
        `*Auto-generated placeholder summary (stub provider). Configure \`LLM_PROVIDER\` to swap in a real model.*`,
        ``,
        `This entity was selected for the launch slice based on its filing volume. The structured payload begins: \`${preview}...\``,
      ].join('\n');
      return { text, model: 'stub-v0' };
    },
  };
}
