-- "Admin full access *" policies target role {public} with
-- auth.role() = 'authenticated' — but this project has no user auth
-- (only anon + service_role). They never match anyone, but trigger
-- Supabase linter warnings (multiple_permissive_policies +
-- auth_rls_initplan). Service role bypasses RLS natively so the
-- ingest pipeline is unaffected.
DROP POLICY IF EXISTS "Admin full access hackathons" ON public.hackathons;
DROP POLICY IF EXISTS "Admin full access lfg" ON public.lfg_posts;
