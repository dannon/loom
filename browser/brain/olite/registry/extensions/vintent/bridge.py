"""Bridge: register the absorbed vintent leaves as olite graph primitives."""

from olite.drivers.graph import register_builder, register_materializer

from olite.registry.extensions.vintent.modules.profiler import profile_rows, rows_from_tabular
from olite.registry.extensions.vintent.modules.process import run_process as _run_leaf_process
from olite.registry.extensions.vintent.modules.registry import PROCESSES, SHELLS
from olite.registry.extensions.vintent.modules.tools import (
    NO_PROCESS_ID,
    build_choose_shell_tool,
    build_fill_shell_params_tool,
    build_parse_intent_tool,
)


# --- Materializers (deterministic transforms) -------------------------------


@register_materializer("vintent.profile")
def _profile(text=None):
    """Parse tabular text and profile its columns."""
    values = rows_from_tabular(text or "")
    return {"values": values, "profile": profile_rows(values)}


@register_materializer("vintent.run_process")
def _run_process(choice=None, values=None):
    """Apply a chosen extract process (or none), then re-profile."""
    values = values or []
    choice = choice or {}
    pid = choice.get("id")
    if pid and pid != NO_PROCESS_ID:
        process = PROCESSES.EXTRACT.get(pid)
        if process:
            values = _run_leaf_process(process, values, choice.get("params", {}))
    return {"values": values, "profile": profile_rows(values)}


@register_materializer("vintent.analyze")
def _analyze(shell_id=None, values=None, params=None):
    """Run the chosen shell's analyze processes (if any), then re-profile."""
    values = values or []
    shell = SHELLS.get(shell_id)
    steps = getattr(shell, "processes", None)
    if callable(steps):
        for step in steps(profile_rows(values), params or {}):
            process = PROCESSES.ANALYZE.get(step.get("id"))
            if process:
                values = _run_leaf_process(process, values, step.get("params", {}))
    return {"values": values, "profile": profile_rows(values)}


@register_materializer("vintent.compile")
def _compile(shell_id=None, values=None, params=None, profile=None):
    """Validate shell params against the profile, then compile the Vega-Lite spec."""
    shell = SHELLS.get(shell_id)
    if shell is None:
        raise ValueError(f"unknown shell: {shell_id}")
    shell.validate_or_raise(profile or profile_rows(values or []), params or {})
    spec = shell.compile(params or {}, values or [], "vega-lite")
    return {"spec": spec, "title": getattr(shell, "name", shell_id)}


# --- Schema-builders (state-derived decision contracts) ----------------------


def _params(tool, refusal):
    """Unwrap a built tool's parameter schema, or raise `refusal` if it built none."""
    if not tool:
        raise ValueError(refusal)
    return tool["function"]["parameters"]


def _describe(profile):
    fields = (profile or {}).get("fields") or {}
    if not fields:
        return "the dataset has no columns to plot"
    listed = ", ".join(f"{n} ({m.get('type', 'nominal')})" for n, m in fields.items())
    return f"columns: {listed}"


@register_builder("vintent.parse_intent_schema")
def _parse_intent_schema(profile=None):
    return _params(
        build_parse_intent_tool(profile),
        f"cannot read the request against this dataset: {_describe(profile)}",
    )


@register_builder("vintent.choose_process_schema")
def _choose_process_schema(profile=None):
    applicable = []
    for pid, process in PROCESSES.EXTRACT.items():
        builder = process.get("schema")
        if builder and builder(profile):
            applicable.append(pid)
    return {
        "type": "object",
        "properties": {
            "id": {"type": "string", "enum": [NO_PROCESS_ID] + sorted(applicable)},
            "params": {"type": "object"},
        },
        "required": ["id"],
        "additionalProperties": False,
    }


@register_builder("vintent.choose_shell_schema")
def _choose_shell_schema(profile=None, intent=None):
    return _params(
        build_choose_shell_tool(profile, intent),
        f"no chart type fits this data — {_describe(profile)}",
    )


@register_builder("vintent.fill_params_schema")
def _fill_params_schema(shell_id=None, profile=None, intent=None):
    shell = SHELLS.get(shell_id)
    if shell is None:
        raise ValueError(f"unknown shell: {shell_id}")
    return _params(
        build_fill_shell_params_tool(shell, profile, intent),
        f"chart '{shell_id}' needs a column type this data lacks — {_describe(profile)}",
    )
