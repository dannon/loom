"""Numeric assertions must survive a model's thousands separators."""

import pathlib
import sys

EVALS = pathlib.Path(__file__).resolve().parents[2] / "evals"
sys.path.insert(0, str(EVALS))

from lib.assertions import _grouped_forms  # noqa: E402


def test_a_number_matches_however_the_model_groups_it():
    forms = _grouped_forms("96000")
    for written in ("96000", "96,000", "96 000", "96\u00a0000", "96\u202f000", "96_000", "96.000"):
        assert any(f == written for f in forms), written


def test_unrelated_text_is_not_rewritten():
    # the old approach joined "chr1 100" into "chr1100"; needle variants cannot.
    assert _grouped_forms("chr1") == ["chr1"]
    assert _grouped_forms("60") == ["60"]


def test_longer_numbers_group_in_threes():
    assert "1,000,000" in _grouped_forms("1000000")
