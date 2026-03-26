from __future__ import annotations

import re
import unicodedata
from datetime import date

from src.config import AR_CITIES, TAG_KEYWORDS, TYPE_KEYWORDS
from src.models import Hackathon, RawEvent


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text.lower())
    return re.sub(r"[-\s]+", "-", text).strip("-")


def extract_urls(text: str) -> list[str]:
    return re.findall(r"https?://[^\s)<>\"]+", text)


_SHORT_CITY_KEYS = {"ba", "cba"}


def extract_city(text: str) -> str | None:
    text_lower = text.lower()
    # Check longer keywords first to avoid partial matches
    sorted_keys = sorted(AR_CITIES.keys(), key=len, reverse=True)
    for keyword in sorted_keys:
        if keyword in _SHORT_CITY_KEYS:
            if re.search(rf"\b{re.escape(keyword)}\b", text_lower):
                return AR_CITIES[keyword]
        else:
            if keyword in text_lower:
                return AR_CITIES[keyword]
    return None


def extract_tags(text: str) -> list[str]:
    text_lower = text.lower()
    found: list[str] = []
    for tag, keywords in TAG_KEYWORDS.items():
        if any(kw in text_lower for kw in keywords):
            found.append(tag)
    return found


def extract_type(text: str) -> str | None:
    text_lower = text.lower()
    for type_name, keywords in TYPE_KEYWORDS.items():
        if any(kw in text_lower for kw in keywords):
            return type_name
    return None


SPANISH_MONTHS: dict[str, int] = {
    "enero": 1, "febrero": 2, "marzo": 3, "abril": 4,
    "mayo": 5, "junio": 6, "julio": 7, "agosto": 8,
    "septiembre": 9, "octubre": 10, "noviembre": 11, "diciembre": 12,
}

ENGLISH_MONTHS: dict[str, int] = {
    "january": 1, "february": 2, "march": 3, "april": 4,
    "may": 5, "june": 6, "july": 7, "august": 8,
    "september": 9, "october": 10, "november": 11, "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4,
    "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}

ALL_MONTHS = {**SPANISH_MONTHS, **ENGLISH_MONTHS}


def _month_to_num(name: str) -> int | None:
    return ALL_MONTHS.get(name.lower())


def _make_date(day: int, month: int, year: int = 2026) -> date | None:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def extract_dates(text: str) -> tuple[date | None, date | None]:
    """Try to extract start and end dates from text."""
    # Pattern: "15-16 de abril" or "15 y 16 de abril"
    match = re.search(
        r"(\d{1,2})\s*[-y]\s*(\d{1,2})\s+de\s+(\w+)",
        text,
        re.IGNORECASE,
    )
    if match:
        day1, day2, month_name = int(match.group(1)), int(match.group(2)), match.group(3)
        month = _month_to_num(month_name)
        if month:
            d1, d2 = _make_date(day1, month), _make_date(day2, month)
            if d1 and d2:
                return d1, d2

    # Pattern: "15 de abril" single date
    match = re.search(r"(\d{1,2})\s+de\s+(\w+)", text, re.IGNORECASE)
    if match:
        day, month_name = int(match.group(1)), match.group(2)
        month = _month_to_num(month_name)
        if month:
            d = _make_date(day, month)
            if d:
                return d, d

    # Pattern: "April 15-16" or "Apr 15-16, 2026"
    match = re.search(
        r"(\w+)\s+(\d{1,2})\s*-\s*(\d{1,2})(?:,?\s*(\d{4}))?",
        text,
        re.IGNORECASE,
    )
    if match:
        month_name, day1, day2 = match.group(1), int(match.group(2)), int(match.group(3))
        year = int(match.group(4)) if match.group(4) else 2026
        month = _month_to_num(month_name)
        if month:
            d1, d2 = _make_date(day1, month, year), _make_date(day2, month, year)
            if d1 and d2:
                return d1, d2

    # Pattern: ISO-ish "2026-04-15"
    iso_dates = re.findall(r"\d{4}-\d{2}-\d{2}", text)
    if len(iso_dates) >= 2:
        try:
            return date.fromisoformat(iso_dates[0]), date.fromisoformat(iso_dates[1])
        except ValueError:
            pass
    if len(iso_dates) == 1:
        try:
            return date.fromisoformat(iso_dates[0]), date.fromisoformat(iso_dates[0])
        except ValueError:
            pass

    return None, None


def extract_name(text: str) -> str:
    """Extract event name from text — first line or first sentence."""
    lines = text.strip().split("\n")
    first_line = lines[0].strip()
    # Remove common prefixes
    first_line = re.sub(r"^(RT\s+@\w+:\s*|@\w+\s+)", "", first_line)
    # Remove hashtags from beginning
    first_line = re.sub(r"^[#@]\w+\s*", "", first_line)
    # Truncate at 80 chars
    if len(first_line) > 80:
        first_line = first_line[:77] + "..."
    return first_line or "Hackathon sin nombre"


def parse_raw_event(event: RawEvent) -> Hackathon:
    text = event.raw_text
    name = extract_name(text)
    date_start, date_end = extract_dates(text)
    city = extract_city(text)
    tags = extract_tags(text)
    event_type = extract_type(text)
    urls = extract_urls(text)
    url = event.url or (urls[0] if urls else None)

    return Hackathon(
        id=slugify(name),
        name=name,
        date_start=date_start,
        date_end=date_end,
        city=city,
        url=url,
        source=event.source,
        type=event_type,
        tags=tags,
        description=text[:300].strip(),
    )
