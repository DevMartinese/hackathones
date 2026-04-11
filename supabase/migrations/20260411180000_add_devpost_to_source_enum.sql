-- Extend the `source` check constraint on public.hackathons to accept
-- 'devpost' alongside the existing 'x', 'luma', 'comunidad', 'dorahacks'
-- values. Needed so the new fetchDevpostEvents() source in
-- web/scripts/ingest.mjs can write rows for upcoming Devpost hackathons
-- without hitting a check-constraint violation.
--
-- This migration was applied to the remote database via the Supabase MCP
-- `apply_migration` tool during development; this file versions it in
-- source control so a fresh database clone can reproduce the schema.

ALTER TABLE public.hackathons
  DROP CONSTRAINT hackathons_source_check;

ALTER TABLE public.hackathons
  ADD CONSTRAINT hackathons_source_check
  CHECK (source = ANY (ARRAY['x'::text, 'luma'::text, 'comunidad'::text, 'dorahacks'::text, 'devpost'::text]));
