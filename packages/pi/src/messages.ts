/**
 * The pi-family message model, declared structurally.
 *
 * pi and Oh My Pi ship the same message union under different package scopes
 * (`@earendil-works/*` and `@oh-my-pi/*`) with small per-host additions. The
 * codec never *constructs* a host message except a synthetic user text message,
 * and every surviving native payload is re-emitted through its opaque handle,
 * so structural types are sufficient and let one codec serve both hosts.
 *
 * Each entrypoint asserts its own host role union via
 * {@link AssertHostRolesModelled}, so a host that adds a message role fails
 * typecheck here instead of silently falling through to `default:` at runtime.
 */

export interface TextContent {
    type: "text"
    text: string
}

export interface ImageContent {
    type: "image"
    data: string
    mimeType: string
}

export interface ThinkingContent {
    type: "thinking"
    thinking: string
}

export interface ToolCall {
    type: "toolCall"
    id: string
    name: string
    arguments?: unknown
}

/**
 * The assistant content blocks the codec understands. Vendor or future blocks
 * are not modelled on purpose: `encodeAssistantBlock` files anything it does
 * not recognize as an opaque item, so the payload re-emits verbatim without
 * this union having to enumerate it.
 */
export type AssistantContentBlock = TextContent | ImageContent | ThinkingContent | ToolCall
export type UserContentBlock = TextContent | ImageContent
export type UserContent = string | UserContentBlock[]

export interface UserMessage {
    role: "user"
    content: UserContent
    timestamp: number
}

export interface DeveloperMessage {
    role: "developer"
    content: UserContent
    timestamp: number
}

export interface AssistantMessage {
    role: "assistant"
    content: AssistantContentBlock[]
    timestamp: number
}

export interface ToolResultMessage {
    role: "toolResult"
    toolCallId: string
    toolName: string
    content: UserContentBlock[]
    details?: unknown
    isError: boolean
    /**
     * When set, the host has already pruned this result and sends only its text
     * blocks (`getPrunedToolResultContent`), so image blocks must not be priced.
     */
    prunedAt?: number
    timestamp: number
}

/**
 * Output metadata the host renders into the message text as a trailing notice
 * (`formatOutputNotice`). Left opaque: the notice is a handful of short bracketed
 * clauses plus an unbounded `LSP Diagnostics` block, and the diagnostics text is
 * the only term large enough to matter for an estimate.
 */
export type OutputMeta = Record<string, unknown>

export interface BashExecutionMessage {
    role: "bashExecution"
    command: string
    output?: string
    exitCode?: number | null
    cancelled?: boolean
    truncated?: boolean
    fullOutputPath?: string
    meta?: OutputMeta
    excludeFromContext?: boolean
    timestamp: number
}

/** Oh My Pi's `$$` Python channel; absent from upstream pi. */
export interface PythonExecutionMessage {
    role: "pythonExecution"
    code: string
    output?: string
    exitCode?: number | null
    cancelled?: boolean
    meta?: OutputMeta
    excludeFromContext?: boolean
    timestamp: number
}

export interface CustomMessage {
    role: "custom"
    customType: string
    content: UserContent
    timestamp: number
}

export interface BranchSummaryMessage {
    role: "branchSummary"
    summary: string
    timestamp: number
}

/** Oh My Pi's pre-extensions hook channel, kept for session migration. */
export interface HookMessage {
    role: "hookMessage"
    customType: string
    content: UserContent
    timestamp: number
}

/**
 * Oh My Pi's `@path` auto-read channel. One message can mix text and image
 * files, and each file's own content is what reaches the model, so this is the
 * heaviest non-tool message class and must never price as zero.
 */
export interface FileMentionMessage {
    role: "fileMention"
    files: Array<{
        path: string
        content: string
        image?: ImageContent
    }>
    timestamp: number
}

/**
 * A committed compaction, replayed into context on every request.
 *
 * Oh My Pi carries the snapcompact archive here: with `blocks` the host sends
 * the bare summary followed by those blocks, otherwise it sends the wrapped
 * summary followed by `images`. Either payload is real context the model reads,
 * so leaving it unpriced would make a long archived session look small and let
 * the trigger fire far too late.
 */
export interface CompactionSummaryMessage {
    role: "compactionSummary"
    summary: string
    blocks?: UserContentBlock[]
    images?: ImageContent[]
    timestamp: number
}

export type PiFamilyMessage =
    | UserMessage
    | DeveloperMessage
    | AssistantMessage
    | ToolResultMessage
    | BashExecutionMessage
    | PythonExecutionMessage
    | CustomMessage
    | HookMessage
    | FileMentionMessage
    | BranchSummaryMessage
    | CompactionSummaryMessage

/**
 * Compile-time drift guard for host message roles.
 *
 * The codec prices and renders per `role`, so the failure that matters is a
 * host adding a role the codec does not model: it would fall through to the
 * `default` arm and price as zero, hiding real context from the estimator.
 * Each entrypoint instantiates this with its own host role union, so such an
 * addition fails typecheck in the adapter instead of going quiet at runtime.
 */
export type AssertHostRolesModelled<TRole extends PiFamilyMessage["role"]> = TRole
