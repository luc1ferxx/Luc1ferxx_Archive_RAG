-- Owner and runtime logins for the database role split (optional).
--
-- The application normally logs in as one role that also owns every table, so
-- a statement that loses its tenant context runs as the owner and bypasses
-- row-level security. With POSTGRES_MIGRATION_DATABASE_URL set it uses two
-- logins instead:
--
--   owner    POSTGRES_MIGRATION_DATABASE_URL. Owns the database and every table;
--            runs the migrations and every DDL (index version tables). It needs
--            CREATEROLE so migrations 013 and 035 can create the NOLOGIN tenant
--            and system roles and grant them to the runtime login.
--   runtime  POSTGRES_DATABASE_URL. Owns nothing and holds no table privilege;
--            it switches into the tenant role or the system role per
--            transaction (the migrator grants both to it WITH INHERIT FALSE,
--            SET TRUE). NOINHERIT as well, so that also holds before
--            PostgreSQL 16 and for any grant made later without the option.
--
-- Run it once, as a superuser, for a new database (it creates the database):
--
--   psql "postgresql://postgres@127.0.0.1:5432/postgres" -v ON_ERROR_STOP=1 \
--     -v owner_password='...' -v runtime_password='...' \
--     -f deploy/postgres/create-split-roles.sql
--
-- Optional variables (defaults in brackets): database [archive_rag], owner
-- [archive_rag_owner], runtime [archive_rag_app]. Unset passwords are read
-- from ARCHIVE_RAG_OWNER_PASSWORD and ARCHIVE_RAG_RUNTIME_PASSWORD (psql 15+
-- \getenv), so the file also works from /docker-entrypoint-initdb.d.
--
-- Then point the application at it:
--
--   POSTGRES_MIGRATION_DATABASE_URL=postgresql://archive_rag_owner:...@host:5432/archive_rag
--   POSTGRES_DATABASE_URL=postgresql://archive_rag_app:...@host:5432/archive_rag
--
-- The first start migrates as the owner and grants the tenant and system roles
-- to the runtime login; GET /health then reports
-- checks.rowLevelSecurity.roleSplit.status "ok". It needs pgvector installed
-- (CREATE EXTENSION below, as the superuser running this file).

\set ON_ERROR_STOP on

\if :{?database}
\else
  \set database archive_rag
\endif
\if :{?owner}
\else
  \set owner archive_rag_owner
\endif
\if :{?runtime}
\else
  \set runtime archive_rag_app
\endif
\if :{?owner_password}
\else
  \getenv owner_password ARCHIVE_RAG_OWNER_PASSWORD
\endif
\if :{?runtime_password}
\else
  \getenv runtime_password ARCHIVE_RAG_RUNTIME_PASSWORD
\endif
-- A missing password stops the script (ON_ERROR_STOP: psql exits with 3).
\if :{?owner_password}
\else
  DO $$ BEGIN RAISE EXCEPTION 'Set owner_password (-v owner_password=...) or ARCHIVE_RAG_OWNER_PASSWORD.'; END $$;
\endif
\if :{?runtime_password}
\else
  DO $$ BEGIN RAISE EXCEPTION 'Set runtime_password (-v runtime_password=...) or ARCHIVE_RAG_RUNTIME_PASSWORD.'; END $$;
\endif

CREATE ROLE :"owner" LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB PASSWORD :'owner_password';
CREATE ROLE :"runtime" LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'runtime_password';

CREATE DATABASE :"database" OWNER :"owner";
REVOKE ALL ON DATABASE :"database" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database" TO :"runtime";

\connect :"database"

-- pgvector is not a trusted extension; the owner's migration 012 then finds it.
CREATE EXTENSION IF NOT EXISTS vector;

-- The application's tables live in public. The owner creates them; the runtime
-- login may use the schema (the grants the migrations make need it) but never
-- create anything in it. PostgreSQL 15 and later already deny PUBLIC CREATE.
ALTER SCHEMA public OWNER TO :"owner";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"runtime";
