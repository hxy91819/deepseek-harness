# Agent Note: Admit concurrent ACP prompts as mid-turn steering

Status: implemented

English | [中文](2026-09-18-acp-mid-turn-steering.zh.md)

## Problem

Each `AcpSession` module held one in-flight prompt and rejected a second `session/prompt` with `invalidParams` while a turn ran. The underlying `Agent` already exposes `agent.steer(message)` — next-step input claimed by the running turn at the nearest step boundary, or a fresh turn for an idle driver. ACP automation clients that inject mid-turn steering (a second prompt while the first runs) were refused a capability the runtime supports, and the `initialize` response carried no signal distinguishing the rejection from a missing feature.

## Decision

`AcpSession` tracks in-flight prompts in a `Set<InflightPrompt>`; a message id is assigned asynchronously during admission, so correlation rides each entry's `messageId` field once the queue publishes it rather than a keyed map. The first prompt of a group sends `agent.followup`; a prompt arriving while another is in flight sends `agent.steer`, so it is claimed at the nearest step boundary — extending the running turn when it lands in time, opening a fresh turn otherwise — rather than queueing behind the whole turn group.

Correlation still rides `agent/inbox/claimed`: the event's message id lands the claiming turn number on the matching entry whichever admission path carried it, and `agent/inbox/discarded` settles an entry `cancelled` when its message is removed before any claim. A steered prompt settles exactly like the prompt that opened its claiming turn — a non-error `turn/end` arms its stop reason and whole-agent idle plus the drained update tail settles it, an error end rejects it, and `session/cancel` or teardown resolves every entry `cancelled`. The interval semantics recorded in [followup enqueue and owned runs](../architecture/2026-07-30-followup-enqueue-and-owned-runs.md) are unchanged: a prompt reports the outcome of the activity that admitted it, not a causal attribution.

`initialize` advertises `_meta.midTurnSteering: true`, the ACP `_meta` channel clients use to detect prompt-based mid-turn steering.

## Alternatives considered

**Keep rejecting concurrent prompts.** Rejected: the runtime already supports the injection, so rejection only pushed the cost onto clients — cancel and reprompt, losing the running turn's state.

**Queue the second prompt as a next-turn follow-up.** Rejected: silently deferring the injection past the whole turn group changes the semantics a steering client requested and delays the instruction past the point where it could affect the running turn's next step.

**Resolve each prompt at its own turn/end instead of whole-agent idle.** Rejected: a turn ending is not the session stopping — a steering claim can extend the closing turn, and sibling activity may continue — so early settlement would report `end_turn` while owned work still runs.

## Consequences

Concurrent `session/prompt` calls share the session's turn lifecycle and each resolves with the outcome of the turn that claimed it. `session/cancel` and teardown settle a set of waiters rather than one slot. The single-flight error is gone; the remaining prompt rejections are pre-admission validation, a retired agent, and disposal. The `_meta` marker is additive protocol metadata — clients that never check it observe only that a previously rejected call now succeeds.

## Verification

The turns suite holds a turn open at a gated tool call and shows a second prompt reaching the model inside the same turn — one `turn/start`, the steering text in the following request — and shows every in-flight prompt resolving `cancelled` under `session/cancel`. The multi-session suite covers independent per-session steering; the disposal suite covers teardown settlement of multiple waiters; the bridge suite pins `_meta.midTurnSteering` in `initialize`. The keyless `steer-mid-turn` snapshot scenario drives the assembled ACP server through the snapshot harness `promptAndSteer` operation and pins the `next-step` inbox splice, the same-turn claim, and both `end_turn` results.
