-- Extensiones del schema: gen_random_uuid() y helpers de hash para auth
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Evolution API guarda su estado en una base propia del mismo postgres.
SELECT 'CREATE DATABASE evolution'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'evolution')\gexec
