-- Lock search_path on update_updated_at trigger function to prevent
-- a malicious schema from shadowing `now()` or other builtins.
ALTER FUNCTION public.update_updated_at() SET search_path = public, pg_temp;
