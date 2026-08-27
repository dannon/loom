"""The eval stub must serve what download_dataset expects.

The data-path scenario is only meaningful if the stub answers the dataset endpoints
the tool actually calls; a stub that returned {} would make the scenario fail for the
wrong reason.
"""

import pathlib
import sys

import pytest

EVALS = pathlib.Path(__file__).resolve().parents[2] / "evals"
sys.path.insert(0, str(EVALS))

from lib.harness import DATASET_CSV, DATASET_ID, DATASET_SUM, StubGalaxy  # noqa: E402

from olite.drivers.loop import galaxy_tools  # noqa: E402
from olite.drivers.loop.galaxy_tools import PREVIEW_LINES, _download_dataset  # noqa: E402


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(galaxy_tools, "DATA_DIR", str(tmp_path))


@pytest.mark.asyncio
async def test_the_stub_serves_dataset_bytes_to_the_download_tool():
    out = await _download_dataset(StubGalaxy(), {"dataset_id": DATASET_ID})
    assert out["binary"] is False
    assert out["bytes"] == len(DATASET_CSV.encode("utf-8"))
    with open(out["path"]) as f:
        assert f.read() == DATASET_CSV


@pytest.mark.asyncio
async def test_the_fixture_outlasts_the_preview_so_the_scenario_can_discriminate():
    """Summing the preview must give a different answer than reading the file."""
    out = await _download_dataset(StubGalaxy(), {"dataset_id": DATASET_ID})
    assert out["truncated"] is True

    def total(text):
        rows = [r for r in text.splitlines()[1:] if r]
        return sum(int(r.split(",")[2]) for r in rows)

    assert total(DATASET_CSV) == DATASET_SUM == 96000
    assert total(out["preview"]) != DATASET_SUM
    assert len(out["preview"].splitlines()) == PREVIEW_LINES
