from __future__ import annotations

from thefuzz import fuzz

from src.models import Hackathon


SIMILARITY_THRESHOLD = 75
DATE_PROXIMITY_DAYS = 3


def are_duplicates(a: Hackathon, b: Hackathon) -> bool:
    a_lower, b_lower = a.name.lower(), b.name.lower()
    name_score = max(fuzz.token_sort_ratio(a_lower, b_lower), fuzz.token_set_ratio(a_lower, b_lower))
    if name_score < SIMILARITY_THRESHOLD:
        return False

    if a.date_start and b.date_start:
        diff = abs((a.date_start - b.date_start).days)
        if diff > DATE_PROXIMITY_DAYS:
            return False

    return True


def merge_hackathons(a: Hackathon, b: Hackathon) -> Hackathon:
    """Merge two duplicate hackathons. Prefer luma data (more structured)."""
    primary, secondary = (a, b) if a.source == "luma" else (b, a)
    if primary.source != "luma":
        primary, secondary = a, b

    merged_tags = list(set(primary.tags + secondary.tags))

    return primary.model_copy(
        update={
            "tags": sorted(merged_tags),
            "description": primary.description or secondary.description,
            "url": primary.url or secondary.url,
            "city": primary.city or secondary.city,
            "location": primary.location or secondary.location,
            "type": primary.type or secondary.type,
            "date_start": primary.date_start or secondary.date_start,
            "date_end": primary.date_end or secondary.date_end,
        }
    )


def deduplicate(hackathons: list[Hackathon]) -> list[Hackathon]:
    if not hackathons:
        return []

    result: list[Hackathon] = []

    for h in hackathons:
        merged = False
        for i, existing in enumerate(result):
            if are_duplicates(h, existing):
                result[i] = merge_hackathons(existing, h)
                merged = True
                break
        if not merged:
            result.append(h)

    return result
