# Hands-free coding coordination

## Outcome and constraints

After starting voice while safely stationary, a user can ask for ordinary coding
work, resolve a task conversationally, and hear admission, questions and results
without touching the screen. A clear work request authorizes submission; no
second confirmation phrase is required. Text remains an optional equivalent
input and audit surface.

This increment replaces the prototype's mandatory visible confirmation for
ordinary coding prompts. It does not authorize trust changes, typed dialog
answers, destructive approvals, publication, or external-writer takeover. Those
operations pause until the user can safely review them while stopped. The
coordinator gets no shell or file tools of its own.

Keep full substantive conversation history, stable session identities, bounded
coding context, literal prompt delivery, project exclusion, store:false,
explicit microphone mute, nearby-audio disclosure and the 90-minute voice
window. Memory remains conversation-local. No task decomposition, new worktrees,
durable memory, reconnect, wake lock or OS-permission automation is included.

## Conversation contract

| User says                                                                 | Application transition and response                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Starts voice before moving                                                | Give a brief greeting and current task context. Explain that ordinary requests send work and approvals wait for safe review.                                                                                                         |
| "What am I working on?"                                                   | Describe known tasks and evidence-backed state, using task names rather than requiring handles.                                                                                                                                      |
| "Ask the login task to review the timeout fix."                           | Resolve one task, contextualize the instruction and admit it. Say "Sent to the login task" only after actual admission.                                                                                                              |
| "The other one." after a target question                                  | Resolve the retained ordinary request against the question's candidates and history. Ask one short question if still ambiguous; do not guess.                                                                                        |
| Requests a saved root                                                     | Resume through the normal runtime path only when eligible. Unknown external ownership requires one spoken question tied to this task/request, such as "Is the login session stopped in other apps?" An unrelated yes grants nothing. |
| "Also include a regression test." while coding runs                       | Send a follow-up to that task and acknowledge that it is queued after current work. No steer-versus-follow-up dialogue.                                                                                                              |
| "Use thirty seconds" after a coding question                              | Send a contextual answer to the question's originating task. If several questions could match, ask which task. Typed dialogs remain separate.                                                                                        |
| "Now ask the export task to check its tests."                             | Change focus deliberately. Concurrent updates from other tasks remain attributed and do not steal focus or a pending clarification.                                                                                                  |
| "What's happening?" or "What needs me?"                                   | Report bounded running, queued, waiting, completed or error evidence. Do not invent progress or narrate tool logs. Proactively speak useful questions, results and failures, not every activity event.                               |
| "Stop talking."                                                           | Silence playback, not coding or microphone input. A later request to speak resumes playback.                                                                                                                                         |
| "Stop work on the login task."                                            | Abort that local current turn and report what actually stopped, including queued work handling. Do not claim to undo changes or permanently cancel a task.                                                                           |
| "End voice."                                                              | End the coordinator/voice connection without stopping coding. No screen action is needed.                                                                                                                                            |
| Corrects a technical name or path                                         | Preserve the pending request, resolve the correction before admission and ask for spelling when uncertain. After admission, describe any correction as a new follow-up, not an undo.                                                 |
| Gives ambiguous assent or requests an unsupported/consequential operation | Do not treat it as broad consent. Ask one clarification or explain that work needs safe visible review. Never request screen interaction while driving.                                                                              |

## Repository evidence and decisions

`src/core/coordinator.ts` already owns conversation, focus, request
serialization, observation and admission records.
`src/core/workspace/coordinator.ts` owns the validated coding boundary; it
shares `admit` with normal prompts in `src/core/workspace/deps.ts`.
`src/adapters/pi/agent-runtime.ts` provides normal resume and literal prompt
admission. Keep these owners; no new architectural boundary is justified.

Replace the proposal-only request path, not the underlying writer or approvals.
Preserve pending intent across transcript fragments and clarifying exchanges.
Only delegated captured user input may request reasoning; assistant output and
background session messages are never authorization. Deduplicate delegation and
submission identities, retain later input while reasoning is busy, and do not
silently replay admitted work. Background summaries must not displace a waiting
user request.

Pi's current runtime has process-local open deduplication but no cross-process
writer lock or reliable external-activity detector. A saved ordinary root is not
proof of exclusive ownership. Require task-bound spoken ownership clarification
for every saved resume, reject inspection-only/delegated roots, check project
trust without granting it, and revalidate the saved revision before and after
resume. This is not a claim of cross-process locking. An external writer must
remain stopped after the user's handoff.

GPT-Live transcript deltas have no completed-turn marker. Use delegation plus
semantic resolution of a complete request, never a raw delta or a silence timer,
as the request boundary. Preserve input that arrives while reasoning is in
flight and withhold superseded actions. Do not invent a provider
final-transcript event. Provider documentation:
[delegation](https://developers.openai.com/api/docs/guides/live-delegation) and
[conversation events](https://developers.openai.com/api/docs/guides/live-conversations).

Expose bounded status facts from existing snapshots without consuming notices.
Keep typed approvals and ordinary prose questions distinct. A pending ordinary
request owns its question and focus: a stop-control detour cannot consume them,
whether it succeeds or is refused. Errors report failed attempts; only a bound
answer, explicit cancellation or replacement resolves the ordinary request.
Playback and voice controls use the existing generation-bound browser owner;
coding abort uses the existing runtime operation and must never activate a saved
session.

## Implementation sequence and evidence

1. Extend the existing Workspace coordinator boundary for guarded resume,
   current delivery mode, bounded status and turn abort. Prove trust refusal,
   stale identity refusal, external/inspection-only refusal and project writer
   exclusion before integrating automatic submission.
2. Replace ordinary proposal confirmation with direct admission. Preserve
   pending requests/questions and busy speech; resolve natural task references,
   corrections and ordinary answers using full history. Keep optional visible
   instruction/audit text. Prove actual admission through real core/Workspace
   with fake provider/runtime ports, including exactly-once delegation,
   unrelated assent, assistant-output isolation, follow-up queue acknowledgement
   and admission failure speech.
3. Connect grounded progress/questions/results and distinct spoken playback,
   turn-abort and end-voice controls. Keep the accepted media lifetime behavior.
   Update prompts, optional UI copy and operational documentation. Prove that
   concurrent updates do not hijack focus and approvals remain paused.
4. Self-check the whole conversation contract, run focused checks and one final
   `VITEST_MAX_WORKERS=4 just ci` gate. Run one bounded authorized real smoke in
   the isolated trial: two harmless coordinator-to-Pi requests, each evidenced
   by new persisted input, real tool result and assistant outcome. If microphone
   automation is unavailable, label this text-path evidence and reserve actual
   audio acceptance for the user; do not simulate microphone proof.
5. Obtain one primary independent review of this increment from baseline
   `6fdc21426cb2355d5bc679ccb831b651dd19393b`, including routing authority and
   resumed-writer isolation. Permit one coherent correction and scoped closure;
   stop for human direction on a new cause at closure. Prior accepted prototype,
   UI and history review budgets remain unchanged. Commit, normally push PR159,
   verify exact-head required validation and feedback, and leave trial services
   stopped for supervised relaunch.

## Risks and reversal points

Pause if implementation needs new writer-ownership infrastructure, broader
approval authority, a new provider protocol, unbounded paid attempts or an
unrelated lifecycle redesign. Reject unclear requests rather than pretending
that a model or transcript supplies authority it does not have. A regression can
restore the prior proposal-only path; already admitted coding work and provider
charges are not reversible.

## Verification recorded on 2026-10-01

The implementation passed 114 focused coordinator tests. The full
`VITEST_MAX_WORKERS=4 just ci` gate passed build, lint, types, documentation
checks, 1,709 application tests and five package smoke tests.

One authorized real text-path smoke used the production Hono request route,
OpenAI Responses coordinator and real Pi runtime in an isolated agent directory
and disposable project. The saved task remained stopped until its task-bound
ownership answer. Two ordinary requests then each produced a new persisted user
entry, a successful real `read` tool result and a new assistant outcome using
`codex-lb/gpt-6.1-sol`. Both admissions targeted the same intended task, with
two attributed result updates and no confirmation endpoint. The requests read
`hello.txt` and `README.md`; the previous file and old transcript were not used
as success evidence. No microphone or Live voice connection was used, and no
file modifications were requested. This establishes real text-to-coding
execution, not audio quality or phone usability. The paid smoke preceded two
narrow conversation-state corrections: retiring undelegated input when voice
ends, and retaining the ordinary request's question and focus across successful
or refused turn-stop controls. Red-before-green regressions reproduced the
faults; cancellation, replacement and obsolete-response checks protect against
reviving retired intent. These corrections did not change the exercised
admission/resume path.

Phone/headset behavior, screen lock/background operation, network handoff and
90-minute physical-device operation remain unverified. There is no automatic
reconnect. If provider finalization is unconfirmed, end the coordinator before
retrying. Start and recover only when safely stationary.
