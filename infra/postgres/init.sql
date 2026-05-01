-- PostgreSQL 16 initialisation script
-- Runs once when the container is first created.
-- Schema objects are created idempotently by the cli-tool (ensureSchema),
-- but we set up extensions and roles here.

-- Enable pg_trgm for fuzzy text search on JSONB fields
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Enable btree_gin to support combined GIN + btree indexes
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- Enable uuid-ossp for deterministic UUIDs in deduplication
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable pgvector for HNSW semantic embeddings (Layer 3 entity resolution)
CREATE EXTENSION IF NOT EXISTS vector;

-- Set default timezone
SET timezone = 'UTC';
