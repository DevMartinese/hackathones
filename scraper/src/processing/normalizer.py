from __future__ import annotations

from datetime import date

from src.config import AR_CITIES
from src.models import Hackathon


def normalize_city(city: str | None) -> str | None:
    if not city:
        return None
    normalized = AR_CITIES.get(city.lower())
    return normalized or city


def normalize_tags(tags: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for tag in tags:
        key = tag.lower()
        if key not in seen:
            seen.add(key)
            result.append(tag)
    return sorted(result)


def normalize_hackathon(h: Hackathon) -> Hackathon:
    return h.model_copy(
        update={
            "city": normalize_city(h.city),
            "tags": normalize_tags(h.tags),
        }
    )


def filter_past_events(hackathons: list[Hackathon], cutoff: date | None = None) -> list[Hackathon]:
    cutoff = cutoff or date.today()
    return [
        h for h in hackathons
        if h.date_end is None or h.date_end >= cutoff
    ]


def sort_by_date(hackathons: list[Hackathon]) -> list[Hackathon]:
    def sort_key(h: Hackathon) -> str:
        return h.date_start.isoformat() if h.date_start else "9999-99-99"
    return sorted(hackathons, key=sort_key)


def normalize_all(hackathons: list[Hackathon]) -> list[Hackathon]:
    normalized = [normalize_hackathon(h) for h in hackathons]
    filtered = filter_past_events(normalized)
    return sort_by_date(filtered)
