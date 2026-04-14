-- Tighten RLS policies: remove open INSERT policies that allowed
-- unauthenticated writes via the anon key. The submit flow creates
-- GitHub Issues (not direct DB inserts), and the ingest pipeline
-- uses service_role which bypasses RLS, so no public INSERT access
-- is needed.
--
-- RLS was already enabled and SELECT policies ("Public read approved *")
-- already existed via the Supabase dashboard.

DROP POLICY IF EXISTS "Anyone can submit hackathons" ON public.hackathons;
DROP POLICY IF EXISTS "Anyone can submit lfg" ON public.lfg_posts;
