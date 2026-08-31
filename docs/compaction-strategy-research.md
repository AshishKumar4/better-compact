# Compaction Strategy Research

**Compared versions:** Oh My Pi 18.0.11; `@better-compact/pi` 0.3.1 with `@better-compact/core` 0.1.1 at commit `213492e`  
**Research date:** 2026-08-30

## Conclusion

There is no controlled, public benchmark that compares OMP `remote`, `snapcompact`, `handoff`, `shake`, and `soft` against Better Compact at the same post-compaction token budget on long-running coding tasks. A universal winner is not supported by evidence.

The strongest conclusions under a **session-continuity** definition are:

1. **Preserve trajectory state, not a fact list.** A compacted agent needs to know what it tried, what changed, why decisions were made, where execution currently stands, and what remains. A flat list of facts can still cause repeated work and false continuation.
2. **Distill old reasoning; do not blindly retain or delete it.** Keep recent reasoning raw. Convert older reasoning into decisions, rejected hypotheses, failure causes, unresolved uncertainty, and next actions before removing the token-level trace.
3. **Structured task state is the best-supported design target.** Agent studies such as TRACE, SWE-AGILE, Acon, and Context as a Tool favor trajectory-aware state or reasoning digests over static threshold summaries in their evaluated environments. They do not test OMP or Better Compact directly.
4. **Snapcompact is a serious complementary candidate.** It can preserve much broader chronological surface history than a short summary, and AgentOCR provides external evidence that optical history can retain agent performance in other environments. It still depends on OCR, model-specific billing, and bounded frames.
5. **No native OMP method is a proven replacement.** `handoff` is the native method most directly designed for coherent task continuation. `remote` may preserve OpenAI-native reasoning better than text methods, but it is opaque. `soft` is a conventional lossy fallback. `shake` removes noise but does not preserve the causal task story.
6. **Better Compact is promising but currently deletes reasoning too early.** Its OMP ladder removes old reasoning before assistant-run summaries are produced, so decisions or failed hypotheses stated only in thinking never reach those summaries.

The best-supported architecture is a hybrid:

1. retain a typed task-state ledger and recent raw interaction/reasoning window;
2. distill older reasoning into causal decisions, failures, beliefs, and next actions;
3. remove redundant tool traffic and stale observations;
4. preserve broad older narrative context through selective text or image archival;
5. summarize only what still exceeds the budget;
6. choose retained content using the current task goal and paired continuation failures.

Better Compact implements part of this structure, but not the reasoning digest or typed ledger. Its current reference document is also a capped preview rather than an exact raw archive.

## What “least lossy” means

The primary target in this report is **continuity fidelity**:

> After compaction, the agent should behave like the same agent continuing the same evolving task, not a new agent handed a shallow recap.

This requires:

- goals and non-negotiable constraints;
- current execution position and next action;
- completed, pending, and partially completed work;
- decisions and why they were made;
- failed approaches and why they failed;
- current beliefs and unresolved uncertainty;
- repository state, tests, errors, paths, and symbols;
- enough chronology to understand how the task evolved;
- a recent raw interaction and reasoning window.

Exact external recovery is secondary under this definition. It remains useful for audits and targeted re-reading, but a session is not coherent if the agent must rediscover its own state through artifacts after every compaction.

### Evidence grades

| Grade | Meaning                                                         |
| ----- | --------------------------------------------------------------- |
| A     | Controlled long-running task outcome at a matched token budget  |
| B     | Controlled QA, recall, grounding, or compression experiment     |
| C     | Source-code invariant, contract test, or deterministic behavior |
| D     | Observed field data without a matched control                   |
| E     | Mechanism-based inference                                       |

No OMP or Better Compact method currently has Grade A evidence against the other methods.

## OMP's actual method pipeline

OMP 18 uses an ordered fallback list, not one strategy setting:

```json
["remote", "snapcompact", "handoff", "shake", "soft"]
```

The registry and default order are fixed in [`compaction-methods.ts`](https://github.com/can1357/oh-my-pi/blob/v18.0.11/packages/coding-agent/src/session/compaction-methods.ts). Automatic maintenance selects the first available method and advances after a failure. The dispatch is implemented in [`session-maintenance.ts`](https://github.com/can1357/oh-my-pi/blob/v18.0.11/packages/coding-agent/src/session/session-maintenance.ts).

Availability differs by method:

- `remote` needs a compatible OpenAI Responses route or configured endpoint;
- `snapcompact` needs a model whose catalog entry declares image input; OMP does not probe the route's actual image support;
- `handoff` is skipped for overflow recovery;
- `shake` and `soft` are always available;
- an empty method order disables method selection.

`shake` runs before `session_before_compact`. Other methods reach the extension hook after OMP prepares a whole-turn cut point. Native `remote`, `handoff`, and `soft` can run speculatively before the threshold. `shake` and `snapcompact` are local and are not speculated. Registering any `session_before_compact` handler disables native speculation because OMP preserves the hook's blocking semantics.

This matters when comparing methods: they do not share the same trigger path, latency model, budget control, or fallback behavior.

## Strategy comparison

### 1. `shake`: reversible elision for eligible text

#### Mechanism

OMP scans active history for:

- text in eligible tool results;
- fenced blocks of at least 400 estimated tokens;
- top-level lower-case XML blocks of at least 400 estimated tokens.

Automatic shake protects the newest 16,000 tokens and requires at least 4,000 estimated tokens of savings. It replaces each selected region with:

```text
[shaken ~N tokens — recover: artifact://ID (region N)]
```

The original selected text is written exactly into one session artifact. The implementation is in [`shake.ts`](https://github.com/can1357/oh-my-pi/blob/v18.0.11/packages/agent/src/compaction/shake.ts), with persistence and fallback handling in [`session-maintenance.ts`](https://github.com/can1357/oh-my-pi/blob/v18.0.11/packages/coding-agent/src/session/session-maintenance.ts).

#### Evidence for

- **Exact recovery for selected text:** the artifact contains the original selected string, not a generated summary. **Grade C.**
- **No compaction model:** selection and replacement are deterministic and local. **Grade C.**
- **Preserves structure around the removed region:** tool calls and non-text result blocks remain. **Grade C.**
- **Good first-stage economics:** large logs, file dumps, and fenced payloads can be removed without asking a model to decide their meaning. **Grade E.**

#### Evidence against

- **Low active fidelity for removed text:** the model sees a size estimate and pointer, not the path, error, patch, or output content. **Grade C.**
- **Retrieval is voluntary:** the model must notice the pointer and read the correct artifact region. No OMP benchmark measures this behavior. **Grade E.**
- **Workload-dependent compression:** ordinary prose, short outputs, unsupported XML forms, unfinished fences, images, and recent protected results may remain untouched. **Grade C.**
- **Persistence failure makes removal unrecoverable:** OMP falls back to a pointer-free placeholder when artifact storage fails. **Grade C.**
- **Image and thinking removal are separate and irreversible:** only text elision gets exact artifact recovery. **Grade C.**

#### Best use

First method for tool-heavy sessions. It is not a complete long-history strategy because it can run out of eligible text before reaching the target.

### 2. `snapcompact`: text encoded as images

#### Mechanism

Snapcompact renders conversation text as images. It serializes history, normalizes it, paginates it into pixel-font grids, renders PNGs in native Rust, and attaches those images to future model requests. The implementation and public description are in [`snapcompact.ts`](https://github.com/can1357/oh-my-pi/blob/v18.0.11/packages/snapcompact/src/snapcompact.ts) and the [package README](https://github.com/can1357/oh-my-pi/blob/v18.0.11/packages/snapcompact/README.md).

It is a text/image hybrid:

- one page at the oldest edge remains text;
- one page at the newest edge remains text;
- the middle becomes image frames;
- a large image middle uses high-quality frames at both ends and a denser low-quality center;
- when the frame budget is still exceeded, the oldest part of the dense center is dropped.

Current constants include:

- at most 80 archive frames;
- three high-quality image frames at each image edge;
- a conservative 5,024-token estimate per high-resolution frame;
- about 170 KB estimated base64 per frame;
- a 3 MB per-request frame payload budget.

The current foveated layout is visible in [`planArchive`](https://github.com/can1357/oh-my-pi/blob/v18.0.11/packages/snapcompact/src/snapcompact.ts#L1887-L1994).

#### Information lost before or during rendering

Snapcompact is deterministic as an encoder, but it does not preserve the original transcript byte-for-byte:

- ANSI and whitespace are normalized;
- compatibility characters and some symbols are mapped;
- tool result text is head/tail truncated by serialization defaults;
- tool-call argument values and calls have character caps;
- data URLs are elided;
- old dense-center characters are dropped when the frame cap is exceeded;
- reasoning can be excluded;
- the model must transcribe text from pixels.

The archive persists only the **kept normalized source**, not content already dropped by serialization or frame budgeting.

#### Evidence for

- **No generated summary:** no summarizer can hallucinate or select the wrong topic. **Grade C.**
- **High surface coverage:** within the kept archive, many more literal characters can fit than in an ordinary text summary. **Grade C/E.**
- **Provider-aware shapes:** OMP selects grid geometry by model and billing family. **Grade C.**
- **Committed eval harnesses:** the repository contains SQuAD and provider-specific image-reading programs. The package states that shapes were chosen through SQuAD recall tests. **Grade B design, but see limitation below.**
- **Text edges reduce OCR dependence for both chronological ends.** **Grade C.**

#### Evidence against

- **The model is the OCR engine:** successful rasterization does not prove the model read an identifier, stack trace, or patch correctly. **Grade C/E.**
- **Exact strings are fragile:** `0/O`, `1/l/I`, punctuation, indentation, Unicode, and long wrapped lines are coding-critical. No source contract guarantees exact transcription. **Grade E.**
- **Density and legibility conflict:** larger cells improve reading for some models but fit fewer characters per billed image token. OMP's changelog states this tradeoff directly. **Grade C.**
- **Model and gateway dependence:** vision support, image billing, downscaling, image-count caps, and gateway capability all affect viability. OMP issues [#3247](https://github.com/can1357/oh-my-pi/issues/3247), [#3387](https://github.com/can1357/oh-my-pi/issues/3387), and [#3599](https://github.com/can1357/oh-my-pi/issues/3599) document fixed budget, gateway, and Unicode fallback failures. These reports do not prove current defects, but they show the integration surface. **Grade D.**
- **The public results are incomplete:** benchmark programs are committed, but `.cache/` and `results/` are gitignored. The raw per-shape result tables behind current first-party claims are not auditable from the repository. **Grade C.**
- **Every later request carries image cost and payload.** There is no published coding-task latency or cache study. **Grade C/E.**

#### Best use

Broad historical recall on a measured, vision-capable model when exact copying is not the main task. It needs a coding-specific OCR benchmark before it should be preferred for stack traces, diffs, IDs, or source text.

### 3. `remote`: provider-native opaque state

#### Mechanism

OMP prefers OpenAI's streaming V2 compaction and then V1 `/responses/compact`. The provider returns an encrypted compaction item plus retained history. OMP stores the replacement history in `preserveData` and skips its own local summary.

OpenAI's [Compaction guide](https://developers.openai.com/api/docs/guides/compaction) says the item carries key prior state and reasoning using fewer tokens. It also says the item is opaque and not intended to be human-interpretable.

OMP's implementation is in [`compaction-v2-streaming.ts`](https://github.com/can1357/oh-my-pi/blob/v18.0.11/packages/agent/src/compaction/compaction-v2-streaming.ts), [`openai.ts`](https://github.com/can1357/oh-my-pi/blob/v18.0.11/packages/agent/src/compaction/openai.ts), and [`compaction.ts`](https://github.com/can1357/oh-my-pi/blob/v18.0.11/packages/agent/src/compaction/compaction.ts).

#### Evidence for

- **Preserves provider-native reasoning and item structure:** OMP replays the provider's own compacted state rather than converting it through a second model's prose. **Grade C.**
- **Provider handles its private format:** this can preserve state unavailable in ordinary text summaries. **Grade E.**
- **No redundant local summary call after success.** **Grade C.**
- **Official contract:** OpenAI documents fewer tokens while carrying prior state and reasoning. **Grade C contract, not a quality measurement.**

#### Evidence against

- **No inspectability:** neither OMP nor the user can determine which facts, failures, or exact outputs are encoded. **Grade C.**
- **No published fidelity result:** OpenAI discloses no recall, coding-task, compression-ratio, determinism, or hallucination benchmark for the compaction item. **Grade C.**
- **Provider-bound state:** OMP only reuses the payload on a compatible provider route. Otherwise it re-expands local history and summarizes it. **Grade C.**
- **No exact budget control:** OMP can budget retained user messages, but the opaque item's active token size is not exposed. **Grade C.**
- **No searchable recovery path:** exact historical evidence cannot be grepped or cited from the opaque item. **Grade C.**
- **OMP V2 narrows retained history:** it keeps eligible real user messages within a 64,000-token ceiling and then appends the compaction item. Some old contextual messages can disappear from explicit replay. **Grade C.**

#### Best use

OpenAI-only sessions where preservation of provider-native reasoning may matter more than auditability. Its quality must be treated as unknown until measured.

### 4. `soft`: structured abstractive summary plus raw tail

#### Mechanism

OMP chooses a whole-turn cut point, keeps a recent tail, serializes the older prefix, and asks a compaction model for a structured summary. Later compactions can update the previous summary. The summary prompt requests goals, constraints, progress, decisions, exact technical details, and next steps. OMP also appends a deterministic file-operation list.

The implementation is in [`compaction.ts`](https://github.com/can1357/oh-my-pi/blob/v18.0.11/packages/agent/src/compaction/compaction.ts) and the architecture is documented in [`docs/compaction.md`](https://github.com/can1357/oh-my-pi/blob/v18.0.11/docs/compaction.md).

#### Evidence for

- **Universal:** works with text models and any provider that can generate a summary. **Grade C.**
- **Task-state schema:** the prompt explicitly requests coding state instead of an unconstrained recap. **Grade C.**
- **Recent tail remains verbatim.** **Grade C.**
- **Bounded output:** summary generation has an output cap derived from reserve tokens, up to 16,384 tokens. **Grade C.**
- **Speculative execution can remove blocking latency near the threshold.** **Grade C.**

#### Evidence against

- **Irreversible semantic bottleneck:** anything omitted or altered by the summary is absent from active context. **Grade C.**
- **Long tool results are truncated before summarization:** the summary model cannot preserve text it never receives. **Grade C.**
- **Recursive drift:** later passes can summarize a prior summary, carrying forward omissions or false claims. **Grade C/E.**
- **No source validation:** paths, errors, decisions, completion status, and test results are requested but not checked against the transcript or repository. **Grade C.**
- **Abstractive summaries are fallible:** Maynez et al. found factual inconsistency in neural summaries on news data. This establishes a risk, not an OMP coding-task failure rate. [Paper](https://aclanthology.org/2020.acl-main.173/). **Grade B in another domain.**
- **Compression can hurt detailed reasoning:** a 2025 prompt-compression study found 3–55% relative task losses across its tested methods/tasks and large grounding drops in several settings. These were not coding-agent transcripts. [Study](https://arxiv.org/abs/2503.19114). **Grade B in another domain.**

#### Best use

Portable final fallback. It is compact and easy to consume, but weak for exact historical evidence.

### 5. `handoff`: successor-oriented task document plus raw tail

#### Mechanism

OMP asks a model to write a structured handoff document covering goal, constraints, completed work, decisions, exact technical context, and next steps. That document becomes a normal compaction summary with a recent raw tail.

In OMP 18, handoff does **not** start a new session. It compacts in place. The implementation is documented in [`docs/compaction.md`](https://github.com/can1357/oh-my-pi/blob/v18.0.11/docs/compaction.md#handoff-generation).

#### Evidence for

- **Better task framing than generic summary prose:** the prompt is written for continuation and requests commands, tests, failures, partial work, and ordered next actions. **Grade C.**
- **Sees the full current agent state when generating the document.** **Grade C.**
- **Recent tail remains verbatim.** **Grade C.**
- **Human-inspectable output:** automatic handoffs can optionally be saved to disk. **Grade C.**

#### Evidence against

- **Still an unverified abstraction:** the structured fields can be incomplete or wrong. **Grade C/E.**
- **Not a clean-session reset:** claims based on older OMP behavior are stale. **Grade C.**
- **No explicit output cap equivalent to soft summary's cap was found in the handoff path.** Equal-budget control is weaker. **Grade C.**
- **No exact recovery:** the saved handoff contains generated text, not the deleted transcript. **Grade C.**
- **No matched comparison against `soft`:** the schema looks better for task continuation, but no evidence proves a higher solve rate or recall rate. **Grade E.**

#### Best use

A deliberate phase boundary where a compact, ordered task ledger matters more than broad historical recall.

### 6. Better Compact: staged structural pruning, summaries, and transcript recovery

#### Mechanism

Better Compact's OMP adapter applies stages until a target is met:

1. supersede older repeated reads;
2. remove stale failed-tool inputs;
3. replace older tool traffic with one-line action/result stubs;
4. remove old reasoning;
5. prune remaining old tools;
6. summarize selected assistant runs;
7. summarize the prefix only as a last resort.

Recent tool results, a raw recent tail, and the latest todo are cross-stage protections rather than a separate stage. OpenCode has an additional adapter-specific stage that stubs loaded skill payloads; OMP skills are not in-band ladder items.

Better Compact writes a rendered reference document and adds its path to active context. User and reasoning text are rendered verbatim. Tool inputs and outputs are head-kept up to 20,000 characters each, file mentions are capped, and images become placeholders. Stored plans use a range hash and replay byte-stably until invalidated or regrowth requires another plan.

The implementation is in [`ladder.ts`](https://github.com/AshishKumar4/Better-Compact/blob/213492e411e8a1d9494bad106ac4f71d9f8622e8/packages/core/src/ladder.ts), [`stages.ts`](https://github.com/AshishKumar4/Better-Compact/blob/213492e411e8a1d9494bad106ac4f71d9f8622e8/packages/core/src/stages.ts), [`codec.ts`](https://github.com/AshishKumar4/Better-Compact/blob/213492e411e8a1d9494bad106ac4f71d9f8622e8/packages/pi/src/codec.ts), and [`summarize.ts`](https://github.com/AshishKumar4/Better-Compact/blob/213492e411e8a1d9494bad106ac4f71d9f8622e8/packages/core/src/summarize.ts).

#### Evidence for

- **Graduated loss:** cheap structural stages run before generated summaries. **Grade C.**
- **Action stubs preserve more active state than bare size placeholders:** tool name, target, success, and first error line remain. **Grade C.**
- **Raw recent tail and latest todo remain active.** **Grade C.**
- **Rendered recovery document:** user and reasoning text remain verbatim; tool inputs and outputs remain exact only below the 20,000-character caps. The model gets a direct path to this partial source. **Grade C.**
- **Replay stability:** hash validation and stored plans avoid re-selecting different content on every request. **Grade C.**
- **Target control:** presets aim for 35%, 25%, or 15% of the context window and stop escalating after the target is met. **Grade C target, not achieved-result evidence.**
- **Summary failure containment:** failed summaries fall back to deterministic previews; repeated failures open a circuit breaker. **Grade C.**

#### Evidence against

- **Selection is mostly structural and age-based:** assistant-run priority is based on expected savings and age, not the current task goal or measured downstream utility. **Grade C/E.**
- **Transcript recovery is voluntary:** no benchmark measures whether the model follows the reference before guessing or repeating work. **Grade E.**
- **The reference is not a raw transcript:** long tool payload tails and image contents are unavailable from Better Compact's document. OMP's original session log remains the only raw source. **Grade C.**
- **Stubs omit most output:** exact values beyond the target/status/error line require retrieval. **Grade C.**
- **Run and prefix summaries can hallucinate or omit state:** validation checks shape, not factual agreement with source. **Grade C.**
- **Old reasoning is deleted before it can be summarized:** the OMP ladder runs `reasoningStage` before `assistantRunsStage`. When that stage is needed, the later summary prompt receives turns with reasoning already removed. Decisions, discarded hypotheses, and causal explanations stated only in thinking can disappear. **Grade C mechanism; Grade E continuity impact pending measurement.**
- **Target estimates are approximate:** chars/4 plus provider-overhead calibration is not the provider tokenizer. **Grade C.**
- **Whole-turn OMP boundary:** Better Compact hands the method back when its internal boundary splits a turn, because OMP cannot persist that shape. **Grade C.**
- **No quality benchmark:** the repository tests replay, shape, boundaries, and invariants, not factual recall or task completion after compaction. **Grade C.**

#### Observed compression, not fidelity

A metadata-only scan of the local OMP session store found 62 Better Compact compaction records. Fifty-eight had a usable nonzero first post-compaction provider token count:

- median before: 850,139 tokens;
- median after: 319,301 tokens;
- median reduction: 54.9%;
- mean reduction: 52.7%;
- 54 events reduced the count; 4 increased it;
- observed range: -5.9% to 86.2% reduction.

These are repeated events from long sessions, not independent trials. The first later provider count can include work performed after compaction. This is **Grade D evidence that the integration usually creates headroom**, not evidence that it preserves more useful information.

#### Best use

General long-running coding sessions where staged degradation, task-state visibility, and indexed partial recovery matter. Its advantage over snapcompact or provider compaction remains a hypothesis.

## Head-to-head matrix

| Axis                                    | `shake`                               | `snapcompact`                                               | `remote`                                     | `soft`                                           | `handoff`                                                      | Better Compact                                                                          |
| --------------------------------------- | ------------------------------------- | ----------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Active form                             | placeholders + untouched context      | text edges + PNG text frames + tail                         | opaque provider item + retained items        | generated summary + tail                         | generated task document + tail                                 | user/task text, stubs, selected summaries, raw tail                                     |
| Exact active strings                    | only untouched text                   | possible, not guaranteed by OCR                             | unknown                                      | only if copied into summary                      | only if copied into document                                   | user/raw tail and stub fields; rest requires retrieval                                  |
| Method-provided exact recovery          | yes for artifact-backed selected text | only kept normalized archive source; earlier drops are gone | none from opaque item; original log persists | original session log only; no in-context pointer | saved document is generated, not source; original log persists | user/reasoning text and tool payloads below 20k-char caps; images and longer tails lost |
| Generated claims                        | none                                  | none                                                        | undisclosed                                  | yes                                              | yes                                                            | only summarized runs/prefix                                                             |
| Deterministic transform                 | yes                                   | yes                                                         | undisclosed                                  | no                                               | no                                                             | plan/stubs yes; summaries cached but generated                                          |
| Model dependence                        | low                                   | very high                                                   | provider-specific                            | summary-model-dependent                          | summary-model-dependent                                        | low until summary stages; then model-dependent                                          |
| Compression control                     | weak; eligible material only          | medium; frames and tail, discrete                           | weak/opaque                                  | medium                                           | weak                                                           | strongest explicit target ladder                                                        |
| Coding exactness risk                   | artifact not read                     | OCR, normalization, truncation                              | unknowable                                   | omission/hallucination                           | omission/hallucination                                         | stub omission, retrieval not used, summary error                                        |
| Auditability                            | high                                  | medium                                                      | none                                         | high for output, low for omitted source          | high for output, low for omitted source                        | high                                                                                    |
| Public method-specific quality evidence | none                                  | first-party claims; raw result tables absent                | none                                         | no OMP-specific result                           | no OMP-specific result                                         | no controlled quality result                                                            |

## What external research adds

### Trajectory continuity is more than retained facts

[TRACE](https://arxiv.org/abs/2608.06503) reports that recurrent compression can weaken the influence of recent interactions, causing blocked actions, repeated exploration, and run-to-run instability. Its key observation matches the continuity criterion here: an ordered action–observation history tells the agent what is already done and where it currently stands. A declarative summary can retain entities and progress labels while still flattening that direction. TRACE evaluates candidate summaries through paired closed-loop continuations from the same environment state. Its experiments are on AppWorld, not coding agents.

[SWE-AGILE](https://arxiv.org/abs/2604.11716) addresses reasoning history directly. It keeps a recent sliding window of raw chain-of-thought and replaces older reasoning with concise reasoning digests. The paper argues that keeping every old trace causes context growth and attention dilution, while deleting all old traces forces redundant re-reasoning. It reports a 24.1% SWE-bench Verified result for its trained 8B framework. This does not establish the right window or digest for frontier API models, but it supports **distill-then-prune** over unconditional deletion.

### Optical history is viable, but not yet proven for coding

[AgentOCR](https://arxiv.org/abs/2601.04786) renders accumulated action–observation history as images. On ALFWorld and search-based QA, it reports retaining over 95% of its text-agent task performance while reducing token consumption by over 50%, with up to 80% lower peak tokens. AgentOCR uses a trained optical/self-compression setup and does not test source-code exactness or OMP snapcompact. It provides real evidence that image history can support agent continuity, not evidence that OMP's pixel grids are best.

### Long context itself is not a lossless baseline

[Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) found that model performance changes with the position of relevant information in long contexts. [RULER](https://arxiv.org/abs/2404.06654) found that models with strong needle-in-a-haystack scores can still degrade on multi-hop tracing, aggregation, and QA as context grows. These studies do not test coding-agent compaction, but they show why keeping every old reasoning token is not automatically best.

### Task-aware compression can beat static compression

[LongLLMLingua](https://arxiv.org/abs/2310.06839) improved results in its long-context QA settings by selecting content relative to the current question and allocating budget by relevance. Its tasks are not agent trajectories, but the result supports goal-aware selection over fixed age-only rules.

[Acon](https://arxiv.org/abs/2510.00615) optimized compression guidelines from cases where the uncompressed agent succeeded and the compressed agent failed. Across AppWorld, OfficeBench, and multi-objective QA, it reported 26–54% lower peak token use while improving task success over its compression baselines.

[Context as a Tool](https://arxiv.org/abs/2512.22087) trained an agent to choose when to fold context into a stable task segment, long-term memory, and recent working memory. On SWE-bench Verified, its reported pass rate was 57.6%, compared with 53.8% for its threshold-compression baseline at 500 steps.

[SWE-Pruner](https://arxiv.org/abs/2601.16746) reported 23–54% token reduction on coding-agent tasks while maintaining or improving task results. It uses current-goal-conditioned line selection rather than complete trajectory compaction.

### Compression evaluation needs more than downstream score

[Understanding and Improving Information Preservation in Prompt Compression](https://arxiv.org/abs/2503.19114) found 3–55% relative task losses across its tested compression methods and tasks. It separately measured downstream accuracy, grounding, and reconstructed information. A continuity benchmark must add execution position, repeated work, and causal-state survival to those measures.

## Provisional ranking for continuity

This is a mechanism-based assessment, not a benchmark result.

| Need                                   | Best current candidate | Limitation                                                 |
| -------------------------------------- | ---------------------- | ---------------------------------------------------------- |
| Purpose-built native task continuation | OMP `handoff`          | generated and unverified; no matched comparison            |
| Broad chronological surface memory     | snapcompact            | OCR, normalization, frame truncation, and model dependence |
| OpenAI-native reasoning continuity     | `remote`               | opaque; no public fidelity evidence                        |
| General staged coding context          | Better Compact         | old reasoning deleted before summaries; no typed ledger    |
| Portable fallback                      | `soft`                 | one generated semantic bottleneck                          |
| Noise removal                          | `shake`                | removes content but does not preserve task evolution       |

No candidate is proven best at equal compression. The evidence does not justify changing the default to one native OMP method today.

### What is worth borrowing now

- Borrow `handoff`'s successor-oriented state schema for Better Compact's persistent task ledger.
- Borrow SWE-AGILE's raw-recent-reasoning plus old-reasoning-digest structure.
- Prototype snapcompact as a selective, model-gated stage before the final prefix summary.
- Keep `remote` as a benchmark arm for OpenAI models; do not trust an opaque item by assumption.
- Keep OMP's ordered fallback and speculation orchestration; Better Compact should become a registered OMP method instead of replacing the pipeline through a global hook.

Do not enable a shake-first order merely because its removals are externally recoverable. That optimizes a different objective from session continuity.

## How Better Compact should evolve

### 1. Distill reasoning before pruning it

Replace the current unconditional reasoning stage with two layers:

- a recent raw reasoning window;
- an older reasoning digest containing decisions, rejected hypotheses, failure causes, changed beliefs, uncertainty, and next actions.

Generate the digest from the original turns before reasoning blocks are removed. Do not feed raw old reasoning back forever.

### 2. Maintain a typed task-state ledger

Keep these fields separately from narrative summaries:

- user goal and non-negotiable constraints;
- current execution position and next action;
- completed, pending, and partial work;
- modified/read files;
- commands and test results;
- failed approaches and exact failure causes;
- decisions and rationale;
- current beliefs and unresolved questions.

Update fields from source events. Keep old values until later evidence supersedes them.

### 3. Make selection goal-aware

Current structural and age rules are a good deterministic floor. Add a relevance layer based on the current user goal, plan, files being changed, and unresolved failures. Recompute relevance when the goal changes. Do not let a relevance model remove protected state by itself.

### 4. Add selective optical history

Prototype snapcompact after the task ledger and reasoning digest, but before whole-prefix summarization. Gate it by measured model capability. Keep task state, paths, IDs, errors, code, diffs, commands, and recent reasoning as text. Use images for older conversational and observational history where broad coverage matters more than exact copying.

### 5. Optimize compression from continuation failures

Use TRACE/Acon-style paired continuations: same environment state, full context versus compressed context. Measure repeated actions, blocked actions, wrong termination, lost decisions, and extra steps. Update the compressor from those boundary-local failures.

### 6. Store lossless sources and add per-item anchors

This is secondary to active continuity but still useful. The pi/OMP reference document is a preview: tool payloads are capped and images are elided. Store native removed items in private artifacts and give every stub or ledger fact a stable source range.

### 7. Measure retrieval and re-reasoning

Track transcript/artifact reads, repeated tool calls, repeated analysis, failed lookups, recovery tokens, and time to resume productive work. A compacted agent that reconstructs its own state through repeated work has failed continuity even if it eventually succeeds.

### 8. Integrate with OMP's method registry

OMP's method list is closed today. A proper extension API should let Better Compact register availability, budget controls, speculation policy, outcomes, projected/provider tokens, and recovery metadata.

Then OMP could test method orders such as:

```json
["better-compact", "snapcompact", "remote", "handoff", "soft"]
```

## Benchmark required to choose a winner

### Paired trajectory design

Use the same frozen coding trajectory for every method. Trigger compaction at the same complete turn. Continue from the same repository state with the same model, tools, prompt, temperature, and task budget. This single-event track measures immediate loss.

Arms:

1. no compaction, when the model window permits;
2. `remote`;
3. `snapcompact`;
4. `handoff`;
5. `shake`;
6. `soft`;
7. Better Compact.

Run both:

- **artifact-off:** the model must rely on active context;
- **artifact-on:** transcript and artifact retrieval are allowed and all recovery costs are counted.

Run a second longitudinal track with at least three sequential compactions. Plant new probes between boundaries and score survival by compaction generation. Measure summary drift, contradiction growth, dropped snapcompact center content, exhausted shake candidates, and repeated work. A method must report both single-event and cumulative results.

### Matched budgets without adding another compressor

Do not truncate or pad method outputs after compaction. That would introduce a second method.

For each target budget:

1. define a tolerance band, such as ±10%;
2. tune only the method's native controls on a calibration split;
3. freeze those controls;
4. measure first-post-compaction provider tokens;
5. treat achieved tokens as a covariate;
6. mark a method/budget cell infeasible when its native controls cannot reach the band.

For snapcompact, count provider visual tokens and payload limits. For remote, record that the opaque item prevents direct size inspection.

The full matrix requires an OpenAI Responses model that also accepts images. Replicate every feasible subset on at least one non-OpenAI vision model and one text-only model. Mark unavailable method/model pairs as infeasible. Do not transfer a winner across untested model families.

### Trajectory probes

Plant deterministic facts before compaction:

- exact random identifiers in tool output;
- paths, symbols, migration IDs, and error lines;
- user constraints;
- an accepted decision and a rejected alternative;
- an applied but uncommitted edit;
- a known failing test;
- a pending todo;
- an early, middle, and late copy of otherwise equivalent facts.

After compaction, test:

- direct factual recall;
- byte-exact recovery;
- recognition of failed attempts;
- next-action choice;
- duplicate investigation rate;
- successful continuation through executable tests.

### Primary outcomes

1. task success through deterministic tests;
2. exact-string fidelity;
3. task-state continuity;
4. repeated-tool-call count;
5. artifact recovery success and cost;
6. summary contradiction and unsupported-claim rate;
7. post-compaction tokens, latency, and monetary cost;
8. cache-read/write tokens;
9. variance across repeated trials and degradation across sequential compactions;
10. human audit time.

Use deterministic grading first. LLM judges can support error classification but must not be the sole oracle.

### Datasets

- [SWE-bench Verified](https://www.swebench.com/verified.html) for executable repository tasks;
- [SWE-ContextBench](https://arxiv.org/abs/2602.08316) for reuse of prior coding experience;
- [LongCodeBench](https://arxiv.org/abs/2505.07897) for long code contexts;
- real sanitized Better Compact sessions for realistic tool/output distributions;
- RULER-style synthetic probes embedded inside real trajectories for exact ground truth.

Run a pilot first and derive sample size from paired-score variance. Do not claim a fixed power number before the pilot.

## Decision

The evidence does not justify replacing Better Compact with one OMP method. It does justify changing Better Compact's first priority: preserve causal trajectory state by distilling old reasoning into a typed ledger before pruning it.

The second priority is a paired single-event and longitudinal benchmark that measures coherent continuation: repeated work, blocked actions, wrong termination, lost decisions, belief drift, and executable task success. Selective optical history is the most promising new ladder experiment; OMP `handoff` is the native design most worth borrowing; `remote` is the strongest opaque baseline to test on OpenAI.
