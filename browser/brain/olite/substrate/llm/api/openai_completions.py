"""The OpenAI chat-completions dialect."""

import json
from dataclasses import dataclass, field

from olite.exceptions import ProviderError

MIN = 0.0000001
MAX = 999999999
TEMPERATURE = 0.3
TOP_P = 0.8


@dataclass
class Reply:
    """What the loop needs from a completion, named rather than dug out of JSON."""

    content: str = ""
    tool_calls: list = field(default_factory=list)
    finish_reason: str | None = None
    usage: dict = field(default_factory=dict)
    raw: dict | None = None


class OpenAICompletions:
    id = "openai-completions"

    def url(self, target):
        base = (target.base_url or "").rstrip("/")
        return f"{base}/chat/completions"

    def headers(self, target):
        headers = {"Content-Type": "application/json"}
        if target.api_key is not None:
            headers["Authorization"] = f"Bearer {target.api_key}"
            headers["x-api-key"] = target.api_key
        return headers

    def build_request(self, target, messages, tools=None, tool_choice=None, parallel_tools=True):
        body = {
            "model": target.model.id,
            "messages": messages,
            "max_tokens": target.max_tokens,
        }
        # Some models reject temperature and top_p together; a provider can opt out.
        if target.compat("sampling", True):
            body["temperature"] = _clamp(target.compat("temperature", TEMPERATURE), 0, MAX)
            body["top_p"] = _clamp(target.compat("top_p", TOP_P), MIN, 1)
        if tools:
            body["tools"] = tools
        if tool_choice:
            body["tool_choice"] = tool_choice
        elif tools:
            body["tool_choice"] = "auto" if parallel_tools else _force_first(tools)
        return body

    def parse_reply(self, payload):
        payload = payload if isinstance(payload, dict) else {}
        choice = (payload.get("choices") or [{}])[0] or {}
        message = choice.get("message") or {}
        reply = Reply(
            content=message.get("content") or "",
            tool_calls=message.get("tool_calls") or [],
            finish_reason=choice.get("finish_reason"),
            usage=payload.get("usage") or {},
            raw=payload,
        )
        # pi turns an unusable provider response into a terminal error rather than an
        # empty turn (`stopReason: "error"`); a reply with no stop reason and nothing
        # in it is the endpoint failing, not the model choosing to stop.
        if reply.finish_reason is None and not reply.content and not reply.tool_calls:
            raise ProviderError("The model provider returned an empty response.")
        return reply

    def oversized_tools(self, target, tools):
        """Tool schemas this endpoint would reject, so we do not send a doomed request."""
        cap = target.limits.max_tool_bytes
        if not cap or not tools:
            return []
        too_big = []
        for tool in tools:
            size = len(json.dumps(tool, separators=(",", ":")).encode("utf-8"))
            if size > cap:
                too_big.append((tool.get("function", {}).get("name", "?"), size))
        return too_big


def _clamp(value, low, high):
    return max(low, min(value, high))


def _force_first(tools):
    name = (tools[0].get("function") or {}).get("name")
    if not name:
        raise ValueError("Tool provided without a function name.")
    return {"type": "function", "function": {"name": name}}
