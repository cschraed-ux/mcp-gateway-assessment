/**
 * Token estimation used for admission control.
 *
 * A token-aware limiter has to decide BEFORE the model call how much budget a request may use, but
 * the true count is only known afterwards. We therefore reserve a pessimistic estimate (prompt
 * estimate + the completion ceiling the caller asked for) and later settle to the provider's real
 * `usage`. The prompt estimate is the common "about 4 characters per token" heuristic for English
 * text. In production you would use the provider's tokenizer (tiktoken for OpenAI models) or its
 * `count_tokens` endpoint, so admission would be exact for the prompt half.
 */

export const DEFAULT_MAX_TOKENS = 256;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Budget to reserve for a request: estimated prompt tokens + the requested completion ceiling. */
export function reservationFor(prompt: string, maxTokens: number = DEFAULT_MAX_TOKENS): number {
  return estimateTokens(prompt) + maxTokens;
}
