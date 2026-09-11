"""Reconstruct a dataset's upstream provenance and summarize how it was produced."""

from olite.registry.extensions.lineage.bridge import generate_mermaid

DEFAULT_DEPTH = 4
DEFAULT_LIMIT = 200


class ProcessError(Exception):
    """A Galaxy call the process cannot continue without."""

    def __init__(self, target, error):
        super().__init__(f"{target}: {error}")
        self.target, self.error = target, error


async def _call(substrate, target, payload):
    result = await substrate.catalog.call(target, payload)
    if not result.get("ok"):
        raise ProcessError(target, result.get("error"))
    return result.get("result")


async def lineage_report(substrate, history_id: str, dataset_id: str,
                         depth: int = DEFAULT_DEPTH, limit: int = DEFAULT_LIMIT,
                         src: str = "hda"):
    """Reconstruct a dataset's upstream provenance and render it as a flowchart."""
    graph = await _call(substrate, "galaxy.histories.show.graph.get", {
        "history_id": history_id,
        "seed_src": src,
        "seed_id": dataset_id,
        "direction": "backward",
        "depth": depth,
        "limit": limit,
    })

    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []
    # Galaxy states its own truncation; the client no longer infers it from a walk that stopped.
    truncated = graph.get("truncated") or {}

    return {
        "nodes": nodes,
        "edges": edges,
        "truncated": truncated,
        "artifact": {
            "kind": "mermaid",
            "title": "Dataset lineage",
            "diagram": generate_mermaid(nodes=nodes, edges=edges, seed_id=dataset_id),
        },
    }


lineage_report.capabilities = ["read"]
lineage_report.inputs_help = {
    "dataset_id": "Encoded id of the dataset whose provenance is wanted; the graph is walked backward from it.",
    "src": "Node type of dataset_id: 'hda' for a dataset, 'hdca' for a collection.",
}
lineage_report.when_to_use = (
    "when the user asks how a dataset was made, its lineage, provenance, or the steps that "
    "produced it"
)
