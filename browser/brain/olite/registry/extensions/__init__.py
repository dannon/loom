"""Primitive packs a graph node can call; each registers itself through its bridge."""

from .lineage import bridge as lineage  # noqa: F401
from .vintent import bridge as vintent  # noqa: F401

__all__ = ["lineage", "vintent"]
