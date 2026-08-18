import type { Logger, Summarizer } from "@better-compact/core"
import { complete, type TextContent } from "@oh-my-pi/pi-ai"
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent"

const SUMMARY_MAX_TOKENS = 8_192

/**
 * Side-model transport: one non-streaming completion per job on the session's
 * current model, authenticated through Oh My Pi's own credential resolution.
 *
 * Unlike the pi entry this imports `complete` from the canonical `@oh-my-pi/*`
 * scope directly — Oh My Pi's legacy-pi compatibility shim would resolve the
 * `@earendil-works` specifier too, but routing the native adapter through a
 * compatibility layer is a dependency the adapter does not need.
 */
export function createOmpSummarizer(
    ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
    logger: Logger,
    signal?: AbortSignal,
): Summarizer {
    return {
        async complete(job) {
            const model = ctx.model
            if (!model) {
                logger.warn("Better Compact summary skipped: no active model")
                return null
            }
            if (signal?.aborted) return null
            try {
                const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
                if (!auth.ok) {
                    logger.warn("Better Compact summary auth failed", { error: auth.error })
                    return null
                }
                const response = await complete(
                    model,
                    {
                        messages: [
                            {
                                role: "user",
                                content: [{ type: "text", text: job.prompt }],
                                timestamp: Date.now(),
                            },
                        ],
                    },
                    {
                        // Oh My Pi's `getApiKeyAndHeaders` returns only a key and
                        // headers; the legacy `env` slot it declares is never
                        // populated and `complete` does not accept one.
                        apiKey: auth.apiKey,
                        headers: auth.headers,
                        maxTokens: SUMMARY_MAX_TOKENS,
                        signal,
                    },
                )
                if (response.stopReason === "error" || response.stopReason === "aborted") {
                    logger.warn("Better Compact summary completion failed", {
                        error: response.errorMessage,
                    })
                    return null
                }
                return response.content
                    .filter((block): block is TextContent => block.type === "text")
                    .map((block) => block.text)
                    .join("\n\n")
            } catch (error) {
                logger.warn("Better Compact summary transport failed", {
                    rangeStartMessageId: job.rangeStartMessageId,
                    rangeEndMessageId: job.rangeEndMessageId,
                    error: error instanceof Error ? error.message : String(error),
                })
                return null
            }
        },
    }
}
