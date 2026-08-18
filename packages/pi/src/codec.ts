import {
    assistantRunsStage,
    contentHashKey,
    keyDeduper,
    purgeErrorInputsStage,
    reasoningStage,
    supersedeReadsStage,
    toolsOldStage,
    toolsRemainingStage,
    truncate,
    type Codec,
    type CodecOps,
    type Item,
    type LadderSpec,
    type Turn,
} from "@better-compact/core"
import type {
    AssistantMessage,
    ImageContent,
    OutputMeta,
    PiFamilyMessage,
    TextContent,
    ThinkingContent,
    ToolCall,
    ToolResultMessage,
    UserContent,
    UserContentBlock,
    UserMessage,
} from "./messages"

/**
 * The message union both pi-family hosts deliver to a `context` handler. It is
 * declared structurally in `./messages` so one codec serves pi and Oh My Pi;
 * each entrypoint asserts its host union against it.
 */
export type PiMessage = PiFamilyMessage

type AssistantContent = AssistantMessage["content"][number]

// One IR tool item owns the ToolCall block and its paired ToolResultMessage:
// when the ladder drops the item both natives disappear; when it survives,
// both re-emit verbatim.
export interface ToolPair {
    call: ToolCall
    result?: ToolResultMessage
}

/**
 * The estimation and transcript half of the codec: pure functions over the
 * structural model, so both hosts share one instance.
 */
export const piFamilyCodecOps: CodecOps = {
    estimateTurns(turns) {
        // Core countTokens scale (chars/4) over the host's own model
        // serialization: mirrors convertToLlm (core/messages.ts) +
        // estimateMessageTokens (pi-ai utils/estimate.ts), which count content
        // chars only.
        const chars = turns.reduce((sum, turn) => sum + charsOfTurn(turn), 0)
        return Math.max(0, Math.round(chars / 4))
    },

    estimateItem(item) {
        return Math.max(0, Math.round(charsOfToolPair(pairOf(item)) / 4))
    },

    transcriptLine(item) {
        if (item.kind === "synthetic") return item.text
        if (item.kind === "text") return textOf(item.handle)
        if (item.kind === "reasoning")
            return `[reasoning]\n${(item.handle as ThinkingContent).thinking}`
        if (item.kind === "tool") return formatToolPair(pairOf(item))
        return formatOpaque(item.handle)
    },
}

/**
 * Build a codec typed by one host's own message union.
 *
 * pi-family context-event messages carry no ids (ids live on session entries,
 * not on AgentMessages), so identity is a content hash with occurrence
 * ordinals — stable across requests because the session prefix is append-only.
 *
 * The two casts below are the whole host boundary. Every surviving native
 * payload leaves through the handle it arrived on, and the only value this
 * module ever constructs is a synthetic user text message, which both hosts
 * accept. {@link AssertHostRolesModelled} is what keeps the structural model
 * honest about the roles it must handle.
 */
export function createPiFamilyCodec<TNative>(): Codec<TNative> {
    return {
        encode(native) {
            const claimKey = keyDeduper()
            const messages = native as unknown as PiFamilyMessage[]
            return groupMessages(messages).map((group) => encodeGroup(group, claimKey))
        },

        decode(turns) {
            return turns.flatMap(decodeTurn) as unknown as TNative[]
        },

        ...piFamilyCodecOps,
    }
}

/** Model-typed codec instance for host-agnostic callers and tests. */
export const piCodec = createPiFamilyCodec<PiMessage>()

/** The tool convention shared by both hosts: name, input, and error text. */
export const toolConvention = (item: Extract<Item, { kind: "tool" }>) => {
    const pair = pairOf(item)
    return {
        name: pair.call.name,
        input: pair.call.arguments,
        error: pair.result?.isError ? contentText(pair.result.content) : undefined,
    }
}

/**
 * Stage order shared by both pi-family hosts: prune what the model no longer
 * needs (superseded reads, stale failed inputs, old tool traffic), then old
 * thinking, then whole assistant runs.
 */
export const LADDER_STAGES = [
    supersedeReadsStage,
    purgeErrorInputsStage,
    toolsOldStage,
    reasoningStage,
    toolsRemainingStage,
    assistantRunsStage,
]

export const piSpec: LadderSpec = {
    codec: piFamilyCodecOps,
    // pi has no skill parts and its todo state lives in session details,
    // outside messages — nothing in-band to select or preserve.
    conventions: { tool: toolConvention },
    stages: LADDER_STAGES,
}

// A Turn is one user message, or one assistant message plus the non-user
// messages that follow it (tool results, bash executions, custom messages).
// Non-user messages with no preceding assistant form a headless run.
function groupMessages(messages: PiMessage[]): PiMessage[][] {
    const groups: PiMessage[][] = []
    let run: PiMessage[] | null = null
    for (const message of messages) {
        if (message.role === "user") {
            groups.push([message])
            run = null
        } else if (message.role === "assistant" || run === null) {
            run = [message]
            groups.push(run)
        } else {
            run.push(message)
        }
    }
    return groups
}

function encodeGroup(group: PiMessage[], claimKey: (base: string) => string): Turn {
    const first = group[0]
    const key = claimKey(contentHashKey(group))
    const items: Item[] = []
    const pendingCalls = new Map<string, ToolPair>()

    for (const message of group) {
        if (message.role === "assistant") {
            for (const block of message.content) {
                items.push(encodeAssistantBlock(block, key, items.length, pendingCalls, claimKey))
            }
        } else if (message.role === "user") {
            if (typeof message.content === "string") {
                items.push({
                    kind: "text",
                    key: `${key}#${items.length}`,
                    text: message.content,
                    handle: message,
                })
            } else {
                for (const block of message.content) {
                    items.push(
                        block.type === "text"
                            ? {
                                  kind: "text",
                                  key: `${key}#${items.length}`,
                                  text: block.text,
                                  handle: block,
                              }
                            : { kind: "opaque", key: `${key}#${items.length}`, handle: block },
                    )
                }
            }
        } else if (message.role === "toolResult" && bindResult(pendingCalls, message)) {
            // Paired into its tool item's handle; no separate IR item.
        } else {
            items.push({ kind: "opaque", key: `${key}#${items.length}`, handle: message })
        }
    }

    return {
        key,
        stamp: timestampOf(first),
        role: first.role === "user" ? "user" : "assistant",
        items,
        handle: group,
    }
}

function encodeAssistantBlock(
    block: AssistantContent,
    turnKey: string,
    index: number,
    pendingCalls: Map<string, ToolPair>,
    claimKey: (base: string) => string,
): Item {
    if (block.type === "text")
        return { kind: "text", key: `${turnKey}#${index}`, text: block.text, handle: block }
    if (block.type === "thinking")
        return { kind: "reasoning", key: `${turnKey}#${index}`, handle: block }
    if (block.type === "toolCall") {
        const pair: ToolPair = { call: block }
        pendingCalls.set(block.id, pair)
        return { kind: "tool", key: claimKey(block.id), callId: block.id, handle: pair }
    }
    return { kind: "opaque", key: `${turnKey}#${index}`, handle: block }
}

function bindResult(pendingCalls: Map<string, ToolPair>, result: ToolResultMessage): boolean {
    const pair = pendingCalls.get(result.toolCallId)
    if (!pair || pair.result) return false
    pair.result = result
    return true
}

function decodeTurn(turn: Turn): PiMessage[] {
    const group = turn.handle as PiMessage[] | undefined
    if (!group) return [synthesizeUserMessage(turn)]

    const out: PiMessage[] = []
    for (const message of group) {
        if (message.role === "assistant") {
            out.push(rebuildAssistant(message, turn.items))
        } else if (message.role === "user") {
            const rebuilt = rebuildUser(message, turn.items)
            if (rebuilt) out.push(rebuilt)
        } else if (survives(message, turn.items)) {
            out.push(message)
        }
    }
    // Synthetic replacements (e.g. a collapsed headless run) with no assistant
    // message to carry them are re-emitted as a user message.
    if (!group.some((message) => message.role === "assistant")) {
        const text = syntheticText(turn.items)
        if (text)
            out.unshift({ role: "user", content: [{ type: "text", text }], timestamp: turn.stamp })
    }
    return out
}

function survives(message: PiMessage, items: Item[]): boolean {
    if (
        message.role === "toolResult" &&
        items.some((item) => item.kind === "tool" && pairOf(item).result === message)
    ) {
        return true
    }
    return opaqueSurvives(message, items)
}

function opaqueSurvives(message: PiMessage, items: Item[]): boolean {
    return items.some((item) => item.kind === "opaque" && item.handle === message)
}

function rebuildAssistant(message: AssistantMessage, items: Item[]): AssistantMessage {
    const content: AssistantContent[] = []
    for (const item of items) {
        if (item.kind === "text") content.push(item.handle as TextContent)
        else if (item.kind === "reasoning") content.push(item.handle as ThinkingContent)
        else if (item.kind === "tool") content.push(pairOf(item).call)
        else if (item.kind === "synthetic") content.push({ type: "text", text: item.text })
        else if (!isWholeMessage(item.handle)) content.push(item.handle as AssistantContent)
    }
    return { ...message, content }
}

function rebuildUser(message: UserMessage, items: Item[]): UserMessage | null {
    const content: UserContentBlock[] = []
    for (const item of items) {
        if (item.kind === "synthetic") {
            content.push({ type: "text", text: item.text })
        } else if (item.kind === "text") {
            content.push(
                item.handle === message && typeof message.content === "string"
                    ? { type: "text", text: message.content }
                    : (item.handle as TextContent),
            )
        } else if (item.kind === "opaque" && !isWholeMessage(item.handle)) {
            content.push(item.handle as ImageContent)
        }
    }
    if (content.length === 0) return null
    if (typeof message.content === "string") {
        return content.length === 1 && items[0]?.kind === "text" && items[0].handle === message
            ? message
            : { ...message, content }
    }
    if (
        content.length === message.content.length &&
        content.every((block, index) => block === message.content[index])
    ) {
        return message
    }
    return { ...message, content }
}

function synthesizeUserMessage(turn: Turn): PiMessage {
    return {
        role: "user",
        content: [{ type: "text", text: syntheticText(turn.items) }],
        timestamp: turn.stamp,
    }
}

function syntheticText(items: Item[]): string {
    return items
        .filter((item): item is Extract<Item, { kind: "synthetic" }> => item.kind === "synthetic")
        .map((item) => item.text)
        .filter(Boolean)
        .join("\n\n")
}

function isWholeMessage(handle: unknown): handle is PiMessage {
    return typeof handle === "object" && handle !== null && "role" in handle
}

export function pairOf(item: Extract<Item, { kind: "tool" }>): ToolPair {
    return item.handle as ToolPair
}

function textOf(handle: unknown): string {
    return isWholeMessage(handle) && typeof (handle as { content?: unknown }).content === "string"
        ? ((handle as { content: string }).content as string)
        : (handle as TextContent).text
}

function timestampOf(message: PiMessage): number {
    return typeof message.timestamp === "number" ? message.timestamp : 0
}

// --- estimation: pi's model serialization, priced in chars ---

// Wrappers pi's convertToLlm adds around summary messages, verbatim from
// pi core/messages.ts, so summary turns price as pi serializes them.
const COMPACTION_SUMMARY_PREFIX =
    "The conversation history before this point was compacted into the following summary:\n\n<summary>\n"
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>"
const BRANCH_SUMMARY_PREFIX =
    "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n"
const BRANCH_SUMMARY_SUFFIX = "</summary>"
const ESTIMATED_IMAGE_CHARS = 4800

function charsOfTurn(turn: Turn): number {
    const group = turn.handle as PiMessage[] | undefined
    if (!group) return syntheticText(turn.items).length

    let chars = 0
    for (const message of group) {
        if (message.role === "assistant") {
            for (const item of turn.items) chars += charsOfAssistantItem(item)
        } else if (message.role === "user") {
            chars += charsOfUserItems(turn.items)
        } else if (opaqueSurvives(message, turn.items)) {
            // Paired tool results are priced inside their tool item; only
            // messages surviving as opaque items count here.
            chars += charsOfContextMessage(message)
        }
    }
    if (!group.some((message) => message.role === "assistant"))
        chars += syntheticText(turn.items).length
    return chars
}

function charsOfAssistantItem(item: Item): number {
    if (item.kind === "text") return textOf(item.handle).length
    if (item.kind === "reasoning") return (item.handle as ThinkingContent).thinking.length
    if (item.kind === "tool") return charsOfToolPair(pairOf(item))
    if (item.kind === "synthetic") return item.text.length
    return isWholeMessage(item.handle) ? 0 : charsOfBlock(item.handle)
}

function charsOfUserItems(items: Item[]): number {
    let chars = 0
    for (const item of items) {
        if (item.kind === "synthetic") chars += item.text.length
        else if (item.kind === "text") chars += textOf(item.handle).length
        else if (item.kind === "opaque" && !isWholeMessage(item.handle)) {
            chars += charsOfBlock(item.handle)
        }
    }
    return chars
}

/**
 * Price one content block. An image is charged as the provider's visual-token
 * cost, never as its base64 payload: an inline megabyte of image data is a
 * four-figure token charge, so JSON-length pricing would overstate it by two
 * orders of magnitude and force compaction on a session nowhere near its limit.
 * Assistant content carries images too, not just user content.
 */
function charsOfBlock(handle: unknown): number {
    return (handle as { type?: string }).type === "image"
        ? ESTIMATED_IMAGE_CHARS
        : jsonLength(handle)
}

function charsOfToolPair(pair: ToolPair): number {
    let chars = pair.call.name.length + jsonLength(pair.call.arguments)
    // A pruned result reaches the model as its text blocks alone
    // (`getPrunedToolResultContent`), so its images are no longer context.
    if (pair.result) {
        chars +=
            pair.result.prunedAt === undefined
                ? charsOfUserContent(pair.result.content)
                : charsOfUserContent(pair.result.content.filter((block) => block.type === "text"))
    }
    return chars
}

// The convertToLlm mapping for the non-user, non-assistant messages that reach
// the model as user-role text.
function charsOfContextMessage(message: PiMessage): number {
    switch (message.role) {
        case "toolResult":
            return charsOfUserContent(message.content)
        case "bashExecution":
            return message.excludeFromContext
                ? 0
                : bashExecutionText(message).length + outputNoticeChars(message.meta)
        case "pythonExecution":
            return message.excludeFromContext
                ? 0
                : pythonExecutionText(message).length + outputNoticeChars(message.meta)
        case "developer":
        case "custom":
        case "hookMessage":
            // The hosts drop these when content is neither string nor array
            // (`isCustomMessageContent`), and persisted or extension-supplied
            // content really can be an arbitrary object.
            return isConvertibleContent(message.content) ? charsOfUserContent(message.content) : 0
        case "fileMention":
            return fileMentionChars(message)
        case "branchSummary":
            return (
                BRANCH_SUMMARY_PREFIX.length + message.summary.length + BRANCH_SUMMARY_SUFFIX.length
            )
        case "compactionSummary":
            // With `blocks` the host sends the bare summary plus those blocks;
            // otherwise the wrapped summary plus `images`. Either payload is
            // real replayed context.
            return message.blocks !== undefined
                ? message.summary.length + charsOfUserContent(message.blocks)
                : COMPACTION_SUMMARY_PREFIX.length +
                      message.summary.length +
                      COMPACTION_SUMMARY_SUFFIX.length +
                      charsOfUserContent(message.images ?? [])
        default:
            // Every role the hosts convert is handled above; the shared model's
            // role guard is what keeps that true.
            return 0
    }
}

/**
 * Mirrors the hosts' `isCustomMessageContent`: content that is neither a string
 * nor an array is dropped rather than converted. Without this the estimator
 * throws on such a message, the entrypoint catches it, and the request silently
 * goes out unpruned — a worse failure than pricing it at zero.
 */
function isConvertibleContent(content: UserContent): boolean {
    return typeof content === "string" || Array.isArray(content)
}

function charsOfUserContent(content: UserContent): number {
    if (typeof content === "string") return content.length
    return content.reduce((sum, block) => sum + charsOfBlock(block), 0)
}

/**
 * Mirrors Oh My Pi's `fileMention` conversion: every mentioned file is wrapped
 * in a `<file path="…">` block, with image-bearing files additionally
 * contributing an image block. Upstream pi has no mention channel, so this is
 * never reached there.
 */
function fileMentionChars(message: Extract<PiMessage, { role: "fileMention" }>): number {
    let chars = 0
    for (const file of message.files) {
        chars += `<file path="${file.path}">\n${file.content}\n</file>`.length
        if (file.image) chars += ESTIMATED_IMAGE_CHARS
    }
    return chars
}

// Mirrors bashExecutionToText (both hosts' session/messages.ts) so bash history
// prices as the user-role text the host actually sends.
function bashExecutionText(bash: Extract<PiMessage, { role: "bashExecution" }>): string {
    let text = `Ran \`${bash.command}\`\n`
    text += bash.output ? `\`\`\`\n${bash.output}\n\`\`\`` : "(no output)"
    if (bash.cancelled) text += "\n\n(command cancelled)"
    else if (bash.exitCode !== null && bash.exitCode !== undefined && bash.exitCode !== 0) {
        text += `\n\nCommand exited with code ${bash.exitCode}`
    }
    if (bash.truncated && bash.fullOutputPath)
        text += `\n\n[Output truncated. Full output: ${bash.fullOutputPath}]`
    return text
}

// Mirrors pythonExecutionToText (Oh My Pi session/messages.ts) so `$$` history
// prices as the user-role text the host actually sends. Upstream pi has no
// Python channel, so this branch is simply never reached there.
function pythonExecutionText(python: Extract<PiMessage, { role: "pythonExecution" }>): string {
    let text = `Ran Python:\n\`\`\`python\n${python.code}\n\`\`\`\n`
    text += python.output ? `Output:\n\`\`\`\n${python.output}\n\`\`\`` : "(no output)"
    if (python.cancelled) text += "\n\n(execution cancelled)"
    else if (python.exitCode !== null && python.exitCode !== undefined && python.exitCode !== 0) {
        text += `\n\nExecution failed with code ${python.exitCode}`
    }
    return text
}

/**
 * Length of Oh My Pi's `formatOutputNotice`, which the host appends to both
 * execution serializations but which is not part of the readable text this
 * codec renders into transcripts.
 *
 * The notice is a few short bracketed clauses plus an unbounded `LSP
 * Diagnostics` block, and only the diagnostics text is large enough to move an
 * estimate. Pricing the metadata by its serialized length captures that term and
 * errs high on the rest, which is the safe direction: overestimating compacts
 * slightly early, underestimating lets the trigger fire far too late.
 */
function outputNoticeChars(meta: OutputMeta | undefined): number {
    return meta === undefined ? 0 : jsonLength(meta)
}

// --- transcript rendering ---

function formatToolPair(pair: ToolPair): string {
    const result = pair.result
    return [
        `[tool:${pair.call.name}] callId=${pair.call.id}${result?.isError ? " status=error" : ""}`,
        `input=${previewJson(pair.call.arguments, 20_000)}`,
        result ? `output=${truncate(contentText(result.content), 20_000)}` : "",
    ]
        .filter(Boolean)
        .join("\n")
}

function formatOpaque(handle: unknown): string {
    if (!isWholeMessage(handle)) {
        const block = handle as { type?: string; mimeType?: string }
        if (block.type === "image") return `[image ${block.mimeType ?? "unknown"}]`
        return `[${block.type ?? "unknown"}] ${previewJson(handle, 20_000)}`
    }
    const message = handle
    switch (message.role) {
        case "user":
        case "developer":
            return typeof message.content === "string"
                ? message.content
                : contentText(message.content)
        case "toolResult":
            return `[orphaned tool result:${message.toolName}] callId=${message.toolCallId}\n${truncate(contentText(message.content), 20_000)}`
        case "bashExecution":
            return `[bash]\n${bashExecutionText(message)}`
        case "pythonExecution":
            return `[python]\n${pythonExecutionText(message)}`
        case "custom":
        case "hookMessage":
            return `[${message.role === "custom" ? "custom" : "hook"}:${message.customType}]\n${typeof message.content === "string" ? message.content : contentText(message.content)}`
        case "fileMention":
            return message.files
                .map(
                    (file) =>
                        `[file mention: ${file.path}]\n${truncate(file.content, 20_000)}${file.image ? `\n[image ${file.image.mimeType}]` : ""}`,
                )
                .join("\n\n")
        case "branchSummary":
            return `[branch summary]\n${message.summary}`
        case "compactionSummary":
            return `[compaction summary]\n${message.summary}`
        default:
            return `[${message.role}] ${previewJson(message, 20_000)}`
    }
}

export function contentText(content: (TextContent | ImageContent)[]): string {
    return content
        .map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType}]`))
        .filter(Boolean)
        .join("\n")
}

function jsonLength(value: unknown): number {
    try {
        return JSON.stringify(value)?.length ?? 0
    } catch {
        return String(value).length
    }
}

function previewJson(value: unknown, maxChars: number): string {
    if (value === undefined) return ""
    try {
        return truncate(typeof value === "string" ? value : JSON.stringify(value), maxChars)
    } catch {
        return truncate(String(value), maxChars)
    }
}
