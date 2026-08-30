-- Backfill the value labels anton used to assume (anton-prng).
--
-- `jobValueScore` used to hardcode `risk:high` / `blocking-PR`; it now reads the project's own
-- nominations and defaults to NONE. That default is right for a board anton has never seen — and
-- wrong for a board it has already been ranking, where dropping to no nominations silently sinks
-- every governed job into the age band and holds it below the on-pace value bar.
--
-- So the two labels anton assumed are written down as what they always were: this project's
-- nominations. Existing rows only, and only where the operator has not spoken — a project created
-- after this migration starts with none, and one that already carries `valueLabels` (including a
-- deliberately empty list) is left exactly as it is.
UPDATE `projects`
SET `settings_json` = json_set(`settings_json`, '$.valueLabels', json('["risk:high","blocking-PR"]'))
WHERE json_valid(`settings_json`)
  AND json_type(`settings_json`) = 'object'
  AND json_type(`settings_json`, '$.valueLabels') IS NULL;
