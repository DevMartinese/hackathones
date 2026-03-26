from datetime import date

from src.models import Hackathon
from src.processing.normalizer import (
    filter_past_events,
    normalize_city,
    normalize_hackathon,
    normalize_tags,
    sort_by_date,
)


def _make_hackathon(**kwargs) -> Hackathon:
    defaults = {
        "id": "test",
        "name": "Test",
        "source": "x",
        "description": "Test",
        "tags": [],
    }
    defaults.update(kwargs)
    return Hackathon(**defaults)


def test_normalize_city_caba():
    assert normalize_city("caba") == "Buenos Aires"


def test_normalize_city_cordoba():
    assert normalize_city("córdoba") == "Cordoba"


def test_normalize_city_unknown():
    assert normalize_city("Ushuaia") == "Ushuaia"


def test_normalize_city_none():
    assert normalize_city(None) is None


def test_normalize_tags_dedup():
    assert normalize_tags(["AI", "ai", "web3"]) == ["AI", "web3"]


def test_normalize_hackathon():
    h = _make_hackathon(city="caba", tags=["AI", "ai", "web3"])
    n = normalize_hackathon(h)
    assert n.city == "Buenos Aires"
    assert len(n.tags) == 2


def test_filter_past_events():
    events = [
        _make_hackathon(id="past", date_end=date(2020, 1, 1)),
        _make_hackathon(id="future", date_end=date(2030, 1, 1)),
        _make_hackathon(id="no-date", date_end=None),
    ]
    result = filter_past_events(events, cutoff=date(2026, 1, 1))
    ids = [h.id for h in result]
    assert "past" not in ids
    assert "future" in ids
    assert "no-date" in ids


def test_sort_by_date():
    events = [
        _make_hackathon(id="c", date_start=date(2026, 6, 1)),
        _make_hackathon(id="a", date_start=date(2026, 4, 1)),
        _make_hackathon(id="b", date_start=date(2026, 5, 1)),
        _make_hackathon(id="d", date_start=None),
    ]
    result = sort_by_date(events)
    assert [h.id for h in result] == ["a", "b", "c", "d"]
