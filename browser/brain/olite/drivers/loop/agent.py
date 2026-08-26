"""The open-ended agent loop: LLM -> tool calls -> results -> repeat."""

import json
import logging

from olite import compaction
from olite.substrate import Cancellation

from .brief import brief

from .tools import ToolSurface

logger = logging.getLogger(__name__)

# A backstop for an unattended tab; pi and loom cap nothing. Exhaustion is reported.
MAX_STEPS = 40
# Output hit the token limit, so its tool calls may be silently incomplete.
TRUNCATED = "length"
TRUNCATED_ERROR = (
    'Tool call "{name}" was not executed: the response hit the output token limit, so '
    "its arguments may be truncated. Re-issue the tool call with complete arguments."
)
# Reported back rather than replaced with `{}`, which would run the wrong request.
MALFORMED_ARGS_ERROR = 'Tool call "{name}" was not executed: its arguments are not valid JSON ({detail}).'
# pi's wording for a call dropped because the run was aborted.
ABORTED_ERROR = "Operation aborted"
# Tool results are NOT truncated, matching Orbit.


class LoopDriver:
    def __init__(self, substrate, processes=None, skills=None, confirmation=None):
        self.substrate = substrate
        self.tools = ToolSurface(substrate, processes, skills, confirmation)
        self.compaction = compaction.Settings(
            getattr(substrate, "config", None), getattr(substrate.llm, "target", None)
        )

    async def run(self, transcripts, on_event=None, cancellation=None):
        messages = [dict(m) for m in transcripts]
        # This run's output, kept apart from the transcript that compaction rewrites.
        produced = []
        logs = []
        done = False
        exhausted = True  # cleared by whichever branch ends the loop deliberately
        aborted = False
        reported_overflow = False
        # The provider's own token count and where it was measured.
        measured = None
        cancellation = cancellation or Cancellation()

        for _ in range(MAX_STEPS):
            if cancellation.aborted:
                aborted, exhausted = True, False
                break

            # Top of a step is the only point where every tool call has its result.
            messages, status = await compaction.compact(
                messages, self.substrate.llm, self.compaction, cancellation, measured
            )
            if status == compaction.COMPACTED:
                logs.append("compacted the conversation")
                _emit(on_event, {"type": "compacted"})
                # The index it carried does not point into the rewritten transcript.
                measured = None
            elif status == compaction.IMPOSSIBLE and not reported_overflow:
                # Once per turn: the condition persists and would bury the output.
                reported_overflow = True
                logs.append("over the context budget with nothing left to compact")
                _emit(on_event, {"type": "context_overflow"})

            try:
                reply = await self.substrate.llm.complete(
                    messages,
                    tools=self.tools.schemas(),
                    cancellation=cancellation,
                    on_retry=lambda info: _emit(on_event, {"type": "llm_retry", **info}),
                )
            except Exception:
                # The flag decides whether this was the abort, never the error text.
                if not cancellation.aborted:
                    raise
                aborted, exhausted = True, False
                break

            truncated = reply.finish_reason == TRUNCATED
            tool_calls = reply.tool_calls
            # An empty final is ambiguous without this: a choice to stop, or a spent budget.
            _detail = (reply.usage or {}).get("completion_tokens_details") or {}
            logs.append(
                f"reply: finish={reply.finish_reason} content={len(reply.content or '')} "
                f"tools={len(tool_calls or [])} "
                f"completion={(reply.usage or {}).get('completion_tokens')} "
                f"reasoning={_detail.get('reasoning_tokens')}"
            )

            assistant = {
                "role": "assistant",
                "content": reply.content,
                "tool_calls": tool_calls,
            }
            messages.append(assistant)
            produced.append(assistant)
            # Kept beside the message, which goes back to the provider verbatim.
            counted = compaction.usage_tokens(reply.usage)
            if counted:
                measured = {"tokens": counted, "index": len(messages) - 1}

            if not tool_calls:
                if reply.content:
                    logs.append(f"assistant: {reply.content}")
                exhausted = False
                break

            terminating = []
            for call in tool_calls:
                fn = call.get("function", {})
                name = fn.get("name")
                call_id = call.get("id")

                refusal = None
                args = {}
                if cancellation.aborted:
                    # Every remaining call still needs a result, or the next request
                    refusal = ABORTED_ERROR
                elif truncated:
                    refusal = TRUNCATED_ERROR.format(name=name)
                else:
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                    except json.JSONDecodeError as e:
                        refusal = MALFORMED_ARGS_ERROR.format(name=name, detail=e)

                # Live tool progress; a refused call emits the pair too.
                _emit(on_event, {"type": "tool_start", "id": call_id, "name": name})
                if refusal is not None:
                    logs.append(f"refuse {name}: {refusal}")
                    content, is_error = refusal, True
                else:
                    logs.append(f"call {name}({brief(args)})")
                    outcome = await self.tools.dispatch(name, args)
                    logs.append(f"  -> {brief(outcome.content)}")
                    content, is_error = outcome.text, outcome.is_error
                tool_message = {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "name": name,
                    "content": content,
                }
                messages.append(tool_message)
                produced.append(tool_message)
                # `is_error` rides the event so the shell states the outcome.
                _emit(
                    on_event,
                    {"type": "tool_end", "id": call_id, "name": name, "content": content, "is_error": is_error},
                )

                # Only an executed `finish` counts; a refused one was never dispatched.
                terminating.append(name == "finish" and refusal is None)

            # pi ends a turn only when every call in the batch asked to.
            if terminating and all(terminating):
                done = True
                exhausted = False
                break

            if cancellation.aborted:
                aborted, exhausted = True, False
                break

        return {
            "logs": logs,
            "messages": messages,
            "new_messages": produced,
            "done": done,
            "aborted": aborted,
            "exhausted": exhausted,
            "artifacts": self.tools.artifacts,
        }


def _emit(on_event, event):
    """Deliver a progress event to the optional listener; never let it break the loop."""
    if on_event is None:
        return
    try:
        on_event(event)
    except Exception:
        logger.debug("on_event listener raised", exc_info=True)


