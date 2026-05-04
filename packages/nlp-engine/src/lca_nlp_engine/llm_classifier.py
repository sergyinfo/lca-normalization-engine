"""
LLM-on-residual SOC classifier
==============================
Stage-3 classifier for the long tail of records that Stage 2 retrieval cannot
confidently assign (cosine similarity below NLP_STAGE2_THRESHOLD).

The LLM is *not* asked to produce a SOC code from scratch (it would hallucinate).
Instead it picks from a pre-retrieved short list of top-K candidates that the
Stage 2 sentence-transformer surfaces. This combines retrieval recall with
LLM discrimination on close-neighbour distinctions.

Two backends:

  * `OllamaBackend`     — local llama3.1:8b (or any tag) via Ollama HTTP API.
                          Recommended for thesis: free, reproducible, no API key.

  * `AnthropicBackend`  — Anthropic Messages API. Requires ANTHROPIC_API_KEY.
                          Faster and more accurate, but costs money and adds
                          a network dependency to the pipeline.

Both backends return `LlmDecision` with the chosen candidate index and a
confidence flag. The caller decides whether to commit or leave in quarantine.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Optional, Protocol, Sequence

import structlog

from lca_nlp_engine.soc_classifier import SocPrediction

log = structlog.get_logger(__name__)


# Titles shorter than this carry elevated risk of literal-string LLM picks
# ("Partner" → Lawyers, "Cellar Lead" → Industrial Engineer, etc.). When the
# LLM is otherwise confident, we still downgrade so the caller routes to HITL.
SHORT_TITLE_THRESHOLD = int(os.environ.get("LLM_SHORT_TITLE_THRESHOLD", "12"))


@dataclass(frozen=True, slots=True)
class LlmDecision:
    """LLM's choice from a short list of SOC candidates."""

    choice_index: int    # 1-based index into the candidate list; 0 = none fit
    confident: bool
    reason: str
    raw: str             # the LLM's raw response, for audit/debug
    review_reason: Optional[str] = None  # set when a gate downgrades confident=True


class LlmBackend(Protocol):
    def complete(self, prompt: str) -> str: ...
    def name(self) -> str: ...


class OllamaBackend:
    """Local Ollama server (default: llama3.1:8b)."""

    def __init__(
        self,
        model: str = "llama3.1:8b",
        host: str = "http://localhost:11434",
        timeout: float = 60.0,
    ) -> None:
        self.model = model
        self.host = host.rstrip("/")
        self.timeout = timeout
        # Lazy: don't import httpx at module load to keep cold start fast
        import httpx
        self._client = httpx.Client(timeout=timeout)

    def name(self) -> str:
        return f"ollama:{self.model}"

    def complete(self, prompt: str) -> str:
        resp = self._client.post(
            f"{self.host}/api/generate",
            json={
                "model": self.model,
                "prompt": prompt,
                "stream": False,
                "format": "json",
                "options": {"temperature": 0.0, "num_predict": 200},
            },
        )
        resp.raise_for_status()
        return resp.json().get("response", "")


class AnthropicBackend:
    """Anthropic Messages API (default: claude-haiku-4-5)."""

    def __init__(
        self,
        model: str = "claude-haiku-4-5-20251001",
        api_key: Optional[str] = None,
    ) -> None:
        self.model = model
        api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY not set")
        from anthropic import Anthropic
        self._client = Anthropic(api_key=api_key)

    def name(self) -> str:
        return f"anthropic:{self.model}"

    def complete(self, prompt: str) -> str:
        msg = self._client.messages.create(
            model=self.model,
            max_tokens=300,
            temperature=0.0,
            messages=[{"role": "user", "content": prompt}],
        )
        return msg.content[0].text if msg.content else ""


PROMPT_TEMPLATE = """You are an expert at the U.S. Bureau of Labor Statistics
Standard Occupational Classification (SOC) system. Pick the SOC code from the
candidates below that best matches the given job title.

Job title: {title}
Employer: {employer}{state_part}

Candidate SOC codes:
{candidates}

Rules:
- Choose the candidate that most closely describes the work the title implies.
- If two candidates are roughly equally good, prefer the more specific one over
  any "All Other" / catch-all option.
- If none of the candidates is a reasonable fit, return choice 0.

Respond with JSON ONLY in this exact shape:
{{"choice": <integer 0..{n}>, "confident": <true|false>, "reason": "<<= 12 words>"}}
"""


def _build_prompt(
    title: str,
    employer: Optional[str],
    employer_state: Optional[str],
    candidates: Sequence[SocPrediction],
) -> str:
    state_part = f" ({employer_state})" if employer_state else ""
    cand_lines = "\n".join(
        f"  {i + 1}. {c.code} — {c.title}" for i, c in enumerate(candidates)
    )
    return PROMPT_TEMPLATE.format(
        title=title,
        employer=employer or "(unknown)",
        state_part=state_part,
        candidates=cand_lines,
        n=len(candidates),
    )


# Greedy JSON extraction — Llama sometimes wraps JSON in prose despite format=json
_JSON_RE = re.compile(r"\{[^{}]*\}", re.DOTALL)


def _parse_decision(raw: str) -> Optional[LlmDecision]:
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except Exception:
        m = _JSON_RE.search(raw)
        if not m:
            return None
        try:
            data = json.loads(m.group(0))
        except Exception:
            return None
    try:
        choice = int(data.get("choice", 0))
        confident = bool(data.get("confident", False))
        reason = str(data.get("reason", ""))[:200]
    except Exception:
        return None
    return LlmDecision(choice_index=choice, confident=confident, reason=reason, raw=raw)


class LlmClassifier:
    """Pick the best SOC code among Stage 2 retrieval candidates using an LLM."""

    def __init__(self, backend: LlmBackend) -> None:
        self.backend = backend
        log.info("llm_classifier.init", backend=backend.name())

    def classify(
        self,
        title: str,
        candidates: Sequence[SocPrediction],
        employer_name: Optional[str] = None,
        employer_state: Optional[str] = None,
    ) -> Optional[tuple[SocPrediction, LlmDecision]]:
        """Returns (chosen_candidate, decision) or None if no candidates / parse failure.

        The caller decides whether to act on `decision.confident`.
        """
        if not candidates:
            return None
        prompt = _build_prompt(title, employer_name, employer_state, candidates)
        try:
            raw = self.backend.complete(prompt)
        except Exception:
            log.exception("llm_classifier.backend_failed", title=title)
            return None
        decision = _parse_decision(raw)
        if decision is None:
            log.warning("llm_classifier.parse_failed", title=title, raw=raw[:200])
            return None

        # Short-title gate: LLMs literal-match jargon they don't understand
        # ("Cellar Lead" → Industrial Engineer). Keep the pick but force HITL.
        if decision.confident and len(title.strip()) < SHORT_TITLE_THRESHOLD:
            decision = LlmDecision(
                choice_index=decision.choice_index,
                confident=False,
                reason=decision.reason,
                raw=decision.raw,
                review_reason="short_title_llm_pick",
            )

        if decision.choice_index < 1 or decision.choice_index > len(candidates):
            return (candidates[0], decision)  # caller will see confident=False usually
        return (candidates[decision.choice_index - 1], decision)


def make_default_backend() -> LlmBackend:
    """Pick a backend based on env. Anthropic if ANTHROPIC_API_KEY set, else Ollama."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        return AnthropicBackend(
            model=os.environ.get("LLM_MODEL", "claude-haiku-4-5-20251001"),
        )
    return OllamaBackend(
        model=os.environ.get("LLM_MODEL", "llama3.1:8b"),
        host=os.environ.get("OLLAMA_HOST", "http://localhost:11434"),
    )
