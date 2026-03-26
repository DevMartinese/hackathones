from datetime import date

from src.models import Hackathon
from src.processing.deduplicator import are_duplicates, deduplicate, merge_hackathons


def _make_hackathon(**kwargs) -> Hackathon:
    defaults = {
        "id": "test",
        "name": "Test Hackathon",
        "source": "x",
        "description": "Test",
        "tags": [],
    }
    defaults.update(kwargs)
    return Hackathon(**defaults)


def test_are_duplicates_same_name():
    a = _make_hackathon(name="HackIT BA 2026", date_start=date(2026, 4, 15))
    b = _make_hackathon(name="HackIT BA 2026", date_start=date(2026, 4, 15))
    assert are_duplicates(a, b)


def test_are_duplicates_similar_name():
    a = _make_hackathon(name="HackIT BA 2026 Hackathon", date_start=date(2026, 4, 15))
    b = _make_hackathon(name="HackIT BA 2026", date_start=date(2026, 4, 16))
    assert are_duplicates(a, b)


def test_not_duplicates_different_name():
    a = _make_hackathon(name="HackIT BA 2026", date_start=date(2026, 4, 15))
    b = _make_hackathon(name="ETH LATAM 2026", date_start=date(2026, 4, 15))
    assert not are_duplicates(a, b)


def test_not_duplicates_far_dates():
    a = _make_hackathon(name="HackIT BA 2026", date_start=date(2026, 4, 15))
    b = _make_hackathon(name="HackIT BA 2026", date_start=date(2026, 8, 15))
    assert not are_duplicates(a, b)


def test_merge_prefers_luma():
    a = _make_hackathon(name="Hack BA", source="x", city=None, tags=["AI"])
    b = _make_hackathon(name="Hack BA", source="luma", city="Buenos Aires", tags=["web3"])
    merged = merge_hackathons(a, b)
    assert merged.source == "luma"
    assert merged.city == "Buenos Aires"
    assert "AI" in merged.tags
    assert "web3" in merged.tags


def test_deduplicate():
    events = [
        _make_hackathon(id="1", name="HackIT BA 2026", source="x", date_start=date(2026, 4, 15), tags=["AI"]),
        _make_hackathon(id="2", name="HackIT BA 2026", source="luma", date_start=date(2026, 4, 15), city="Buenos Aires", tags=["web3"]),
        _make_hackathon(id="3", name="ETH LATAM 2026", source="x", date_start=date(2026, 5, 10)),
    ]
    result = deduplicate(events)
    assert len(result) == 2
