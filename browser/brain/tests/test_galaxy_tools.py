"""The loop's Galaxy surface is Orbit's named tools, cloned from galaxy-mcp."""

import asyncio
import json

from olite.drivers.loop.tools import ToolSurface


class FakeManifest:
    def __init__(self, caps):
        self.caps = set(caps)

    def allows(self, capability):
        return capability in self.caps

    def require(self, capability):
        if capability not in self.caps:
            raise PermissionError(f"capability '{capability}' not granted")


class FakeGalaxy:
    def __init__(self, manifest):
        self.manifest = manifest
        self.calls = []

    async def get(self, path):
        self.manifest.require("read")
        self.calls.append(("GET", path))
        return {"path": path}

    async def post(self, path, body=None):
        self.manifest.require("write")
        self.calls.append(("POST", path, body))
        return {"ok": True, "path": path}


class FakeSubstrate:
    def __init__(self, caps=("read",)):
        self.manifest = FakeManifest(caps)
        self.galaxy = FakeGalaxy(self.manifest)


def _names(surface):
    return [t["function"]["name"] for t in surface.schemas()]


def test_surface_is_orbit_named_tools_not_catalog_metatools():
    names = _names(ToolSurface(FakeSubstrate(("read",))))
    for expected in ("run_python", "finish", "get_histories", "get_history_contents", "search_tools_by_name"):
        assert expected in names, expected
    assert "galaxy_ops" not in names
    assert "galaxy_call" not in names


def test_write_tools_advertised_only_with_write():
    read_names = _names(ToolSurface(FakeSubstrate(("read",))))
    rw_names = _names(ToolSurface(FakeSubstrate(("read", "write"))))
    assert "run_tool" not in read_names and "create_history" not in read_names
    assert "run_tool" in rw_names and "create_history" in rw_names


def test_get_histories_hits_the_right_endpoint():
    sub = FakeSubstrate(("read",))
    asyncio.run(ToolSurface(sub).dispatch("get_histories", {"limit": 5}))
    assert sub.galaxy.calls[0][0] == "GET"
    assert sub.galaxy.calls[0][1].startswith("api/histories")
    assert "limit=5" in sub.galaxy.calls[0][1]


def test_run_tool_posts_to_api_tools_and_needs_write():
    # read-only: run_tool routes to GalaxyHttp.post -> require('write') -> raises -> caught.
    sub = FakeSubstrate(("read",))
    out = asyncio.run(ToolSurface(sub).dispatch("run_tool", {"history_id": "h", "tool_id": "cat1", "inputs": {}})).text
    assert "not granted" in out
    # with write: posts to the legacy /api/tools route.
    sub2 = FakeSubstrate(("read", "write"))
    asyncio.run(ToolSurface(sub2).dispatch("run_tool", {"history_id": "h", "tool_id": "cat1", "inputs": {}}))
    assert sub2.galaxy.calls[0][0] == "POST"
    assert sub2.galaxy.calls[0][1] == "api/tools"
    assert sub2.galaxy.calls[0][2] == {"history_id": "h", "tool_id": "cat1", "inputs": {}}
