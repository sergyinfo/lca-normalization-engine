"""
SOC Code Classifier
===================
Classifies free-text job titles into Standard Occupational Classification (SOC)
codes using a fine-tuned BERT model.

Usage (programmatic):
    classifier = SocClassifier.from_pretrained("/app/models/soc-bert")
    result = classifier.predict("Software Engineer III")
    # SocPrediction(code='15-1252', title='Software Developers', confidence=0.94)

Usage (CLI):
    classify-soc --model /app/models/soc-bert --input records.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import structlog

log = structlog.get_logger(__name__)


@dataclass(frozen=True, slots=True)
class SocPrediction:
    code: str
    title: str
    confidence: float


class SocClassifier:
    """BERT-based SOC code classifier (stub — replace model loading with real impl)."""

    def __init__(self, model_path: str | Path) -> None:
        self.model_path = Path(model_path)
        self._pipeline = None
        log.info("soc_classifier.init", model_path=str(self.model_path))

    @classmethod
    def from_pretrained(cls, model_path: str | Path) -> "SocClassifier":
        instance = cls(model_path)
        instance._load()
        return instance

    def _load(self) -> None:
        """Load the HuggingFace pipeline. Stub — implement when model is available."""
        log.info("soc_classifier.loading_model", path=str(self.model_path))
        # TODO: replace with actual transformers pipeline
        # from transformers import pipeline
        # self._pipeline = pipeline(
        #     "text-classification",
        #     model=str(self.model_path),
        #     device=0 if torch.cuda.is_available() else -1,
        # )

    def predict(self, job_title: str) -> SocPrediction:
        """Predict SOC code for a single job title."""
        if self._pipeline is None:
            # Stub: return a placeholder until model is loaded
            log.warning("soc_classifier.model_not_loaded", job_title=job_title)
            return SocPrediction(code="00-0000", title="UNCLASSIFIED", confidence=0.0)

        result = self._pipeline(job_title, top_k=1)[0]
        return SocPrediction(
            code=result["label"],
            title=result.get("title", ""),
            confidence=round(result["score"], 4),
        )

    def predict_batch(self, job_titles: Sequence[str], batch_size: int = 64) -> list[SocPrediction]:
        """Predict SOC codes for a batch of job titles."""
        return [self.predict(t) for t in job_titles]


def cli_main() -> None:
    parser = argparse.ArgumentParser(description="Classify job titles into SOC codes")
    parser.add_argument("--model", required=True, help="Path to fine-tuned SOC BERT model")
    parser.add_argument("--input", default="-", help="JSONL input file (default: stdin)")
    parser.add_argument("--field", default="job_title", help="Field name in each JSON record")
    args = parser.parse_args()

    classifier = SocClassifier.from_pretrained(args.model)
    source = sys.stdin if args.input == "-" else open(args.input)

    for line in source:
        record = json.loads(line)
        job_title = record.get(args.field, "")
        prediction = classifier.predict(job_title)
        record["soc_code"] = prediction.code
        record["soc_title"] = prediction.title
        record["soc_confidence"] = prediction.confidence
        print(json.dumps(record))
