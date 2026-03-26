from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel


class RawEvent(BaseModel):
    source: Literal["x", "luma"]
    raw_text: str
    url: str | None = None
    author: str | None = None
    scraped_at: datetime


class Hackathon(BaseModel):
    id: str
    name: str
    date_start: date | None = None
    date_end: date | None = None
    city: str | None = None
    location: str | None = None
    url: str | None = None
    source: Literal["x", "luma"]
    type: Literal["presencial", "online", "hibrido"] | None = None
    tags: list[str] = []
    description: str = ""
