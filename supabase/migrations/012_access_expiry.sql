-- Add expires_at to read_requests for 14-day access window
ALTER TABLE read_requests ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- Execs can only SELECT approved requests that haven't expired
DROP POLICY IF EXISTS "Execs can read their own requests" ON read_requests;
CREATE POLICY "Execs can read their own requests" ON read_requests
  FOR SELECT USING (
    auth.uid() = exec_user_id
    AND (
      status != 'approved'
      OR expires_at IS NULL
      OR expires_at > now()
    )
  );
