FROM python:3.11-slim

WORKDIR /app

# System deps for psycopg binary and tokenizers
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev \
    gcc \
    libc6-dev \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip/setuptools for modern pyproject.toml support
RUN pip install --no-cache-dir --upgrade pip setuptools wheel

# Install Python dependencies first (layer cache)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY src/ ./src/
COPY pyproject.toml .

RUN pip install --no-cache-dir -e .

# Model weights are mounted at runtime (see docker-compose.yml)
RUN mkdir -p /app/models

ENV PYTHONUNBUFFERED=1

CMD ["nlp-worker"]
