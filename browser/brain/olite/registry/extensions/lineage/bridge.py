"""Renders a dataset/job lineage as a Mermaid flowchart."""

from olite.drivers.graph import register_materializer


@register_materializer("lineage.mermaid")
def generate_mermaid(datasets=None, jobs=None, source_dataset_id=None):
    """Render a dataset/job lineage as a Mermaid flowchart."""
    datasets = datasets or []
    jobs = jobs or []

    def node_id(prefix, raw):
        return f"{prefix}_" + "".join(c if c.isalnum() else "_" for c in str(raw))

    lines = ["flowchart TD"]

    for d in datasets:
        did = d.get("id")
        label = d.get("name") or did
        marker = "*" if did == source_dataset_id else ""
        lines.append(f'    {node_id("ds", did)}["{marker}{label}"]')

    for j in jobs:
        jid = j.get("id")
        label = j.get("tool_id") or jid
        lines.append(f'    {node_id("job", jid)}(["{label}"])')
        for ref in _dataset_ids(j.get("inputs")):
            lines.append(f'    {node_id("ds", ref)} --> {node_id("job", jid)}')
        for ref in _dataset_ids(j.get("outputs")):
            lines.append(f'    {node_id("job", jid)} --> {node_id("ds", ref)}')

    return "\n".join(lines)


def _dataset_ids(container):
    """Extract dataset ids from a job inputs/outputs mapping or list."""
    if not container:
        return []
    items = container.values() if isinstance(container, dict) else container
    ids = []
    for v in items:
        if isinstance(v, dict) and "id" in v:
            ids.append(v["id"])
        elif isinstance(v, str):
            ids.append(v)
    return ids
