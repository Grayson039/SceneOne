-- Add view_count to submissions
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS view_count integer NOT NULL DEFAULT 0;

-- Security-definer function so any authenticated exec can increment without needing UPDATE RLS on submissions
CREATE OR REPLACE FUNCTION increment_view_count(p_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE submissions SET view_count = view_count + 1 WHERE id = p_id AND public_listing = true;
$$;
