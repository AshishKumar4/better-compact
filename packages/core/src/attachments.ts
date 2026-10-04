import { countTokens } from "./estimate.js"
import type { CodecOps, Item, Turn } from "./ir.js"

/** Metadata only. The host can read the payload from the owning item's handle. */
export interface Attachment {
    id: string
    kind: "image" | "file"
    mimeType: string
    width?: number
    height?: number
}

export interface AttachmentLocation {
    sessionKey: string
    turnKey: string
    itemKey: string
}

/** Codec, provider pricing, and storage are host boundaries, not core policy. */
export interface AttachmentPolicy {
    /** Changes when the provider/model or retention policy changes. */
    key: string
    /** Most recent images to keep even when they fall outside the raw tail. Default: two. */
    keepRecentImages?: number
    list(item: Item): readonly Attachment[]
    /** Provider/model-specific visual or file cost; undefined means keep the original. */
    estimateTokens(attachment: Attachment, item: Item): number | undefined
    /** Replace the payload with text, retaining unrelated content and item key.
     * Empty text removes the payload; core carries the recovery link separately. */
    replace(item: Item, attachment: Attachment, text: string): Item
    /** Return a reopenable link only after storage succeeds. Null keeps the original. */
    store(
        attachment: Attachment,
        item: Item,
        location: AttachmentLocation,
    ): Promise<string | null> | string | null
}

export interface AttachmentJob extends AttachmentLocation {
    attachment: Attachment
}

export function attachmentKey(location: AttachmentLocation, attachment: Attachment): string {
    return JSON.stringify([location.turnKey, location.itemKey, attachment.id])
}

export function attachmentStub(attachment: Attachment, link: string): string {
    const dimensions =
        attachment.width && attachment.height ? ` ${attachment.width}x${attachment.height}` : ""
    return `[${attachment.mimeType}${dimensions} → ${link}]`
}

export function isAttachmentReference(item: Item): boolean {
    return item.kind === "synthetic" && item.provenance?.origin === "attachment-reference"
}

/** Replace the codec's generic media estimate with the host's provider estimate. */
export function attachmentCodec(codec: CodecOps, policy?: AttachmentPolicy): CodecOps {
    if (!policy) return codec
    return {
        ...codec,
        estimateTurns(turns) {
            let mediaTokens = 0
            const priced = turns.map((turn) => ({
                ...turn,
                items: turn.items.map((item) => {
                    let withoutMedia = item
                    for (const attachment of policy.list(item)) {
                        const tokens = policy.estimateTokens(attachment, item)
                        if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0) continue
                        mediaTokens += tokens
                        withoutMedia = policy.replace(withoutMedia, attachment, "")
                    }
                    return withoutMedia
                }),
            }))
            return Math.ceil(codec.estimateTurns(priced) + mediaTokens)
        },
    }
}

export function protectedImages(turns: Turn[], policy: AttachmentPolicy): Set<string> {
    const images: string[] = []
    for (const turn of turns) {
        for (const item of turn.items) {
            for (const attachment of policy.list(item)) {
                if (attachment.kind === "image") {
                    images.push(
                        attachmentKey(
                            { sessionKey: "", turnKey: turn.key, itemKey: item.key },
                            attachment,
                        ),
                    )
                }
            }
        }
    }
    const count = Math.max(0, Math.floor(policy.keepRecentImages ?? 2))
    return new Set(count === 0 ? [] : images.slice(-count))
}

export function canOffload(policy: AttachmentPolicy, attachment: Attachment, item: Item): boolean {
    const tokens = policy.estimateTokens(attachment, item)
    return (
        tokens !== undefined &&
        Number.isFinite(tokens) &&
        tokens > countTokens(attachmentStub(attachment, ""))
    )
}
