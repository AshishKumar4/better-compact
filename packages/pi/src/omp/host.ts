import type { ContextEvent, SessionEntry } from "@oh-my-pi/pi-coding-agent"
import type { AssertHostRolesModelled } from "../messages"

/** Oh My Pi's own message union, exactly as its `context` event delivers it. */
export type OmpAgentMessage = ContextEvent["messages"][number]

/**
 * Fails typecheck if Oh My Pi adds a message role the shared codec does not
 * model. Oh My Pi carries `developer` and `pythonExecution` beyond upstream pi,
 * which is why the shared model declares them.
 */
export type _OmpRolesModelled = AssertHostRolesModelled<OmpAgentMessage["role"]>

/**
 * Session entries that carry one message by reference. `buildSessionContext`
 * pushes `entry.message` itself for these, which is what lets a plan boundary
 * be mapped back to a durable entry id without re-deriving host emission rules.
 */
export type MessageEntry = Extract<SessionEntry, { type: "message" }>
