-- Parameters: $1 inclusive release-window start, $2 exclusive end, $3 server release SHA.
-- Same audible-turn cohort and stages as baseline.sql. Also show the new private prefetch start.
WITH turns AS (
  SELECT trace_id,
    max(elapsed_ms) FILTER (WHERE stage='brain_first_token') token,
    max(elapsed_ms) FILTER (WHERE stage='tts_request') tts,
    max(elapsed_ms) FILTER (WHERE stage='tts_prefetch_request') prefetch,
    max(elapsed_ms) FILTER (WHERE stage='first_voiced_audio_published') audio
  FROM voice_turn_timings
  WHERE recorded_at >= $1::timestamptz AND recorded_at < $2::timestamptz
    AND server_release = $3
  GROUP BY trace_id
)
SELECT count(*) audible_turns,
  percentile_cont(ARRAY[0.5,0.9]) WITHIN GROUP (ORDER BY token) first_content_ms,
  percentile_cont(ARRAY[0.5,0.9]) WITHIN GROUP (ORDER BY tts) committed_tts_ms,
  percentile_cont(ARRAY[0.5,0.9]) WITHIN GROUP (ORDER BY prefetch) private_prefetch_ms,
  percentile_cont(ARRAY[0.5,0.9]) WITHIN GROUP (ORDER BY audio) first_voiced_published_ms
FROM turns WHERE audio IS NOT NULL;
