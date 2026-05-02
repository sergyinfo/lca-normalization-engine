"""
Pydantic v2 models for NLP worker BullMQ job payloads.

All incoming Redis messages are validated against these schemas before any
ML or DB work begins. Validation failures are logged and the job is rejected
without updating lca_records.
"""

from __future__ import annotations

import re
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator


_FEIN_RE = re.compile(r"^\d{2}-\d{7}$")
_SOC_RE = re.compile(r"^\d{2}-\d{4}(\.\d{2})?$")


class RecordItem(BaseModel):
    """A single LCA record as enqueued by the ingestor."""

    id: int = Field(..., ge=0)
    nlp_id: str = Field(..., min_length=1)
    filing_year: int = Field(..., ge=2000, le=2100)
    job_title: str = Field(..., min_length=0, max_length=500)
    employer_name: str = Field(..., min_length=0, max_length=500)
    employer_state: Optional[str] = Field(None, min_length=2, max_length=2)
    employer_city: Optional[str] = Field(None, max_length=200)

    @field_validator("employer_city", "employer_name", "job_title", mode="before")
    @classmethod
    def coerce_to_str(cls, v: object) -> Optional[str]:
        # XLSX cells occasionally come through as int/float (e.g. ZIPs in city
        # column). Coerce to string so validation doesn't reject the whole batch.
        if v is None:
            return None
        return v if isinstance(v, str) else str(v)
    fein: Optional[str] = Field(None)
    soc_code: Optional[str] = Field(None)

    @field_validator("fein", mode="before")
    @classmethod
    def validate_fein(cls, v: object) -> Optional[str]:
        if v is None or v == "":
            return None
        if not isinstance(v, str) or not _FEIN_RE.match(v):
            return None  # invalid FEIN treated as missing rather than error
        return v

    @field_validator("employer_state", mode="before")
    @classmethod
    def upper_state(cls, v: object) -> Optional[str]:
        if v is None or v == "":
            return None
        return str(v).upper()

    @field_validator("soc_code", mode="before")
    @classmethod
    def validate_soc_code(cls, v: object) -> Optional[str]:
        if v is None or v == "":
            return None
        s = str(v).strip()
        return s if _SOC_RE.match(s) else None


class NlpJobPayload(BaseModel):
    """Top-level BullMQ job data sent by the ingestor for NLP processing."""

    batch_id: str = Field(..., min_length=1)
    records: list[RecordItem] = Field(..., min_length=1)

    @model_validator(mode="after")
    def no_duplicate_nlp_ids(self) -> "NlpJobPayload":
        ids = [r.nlp_id for r in self.records]
        if len(ids) != len(set(ids)):
            raise ValueError("batch contains duplicate nlp_id values")
        return self


class SocResult(BaseModel):
    """Result written back to lca_records for a single record."""

    nlp_id: str
    filing_year: int
    soc_code: str
    soc_title: str
    soc_confidence: float = Field(..., ge=0.0, le=1.0)
    requires_review: bool = False
    canonical_employer_id: Optional[UUID] = None
    # Preserved for quarantine routing
    employer_name: str = ""
    employer_state: Optional[str] = None
