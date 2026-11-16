-- Points de passage du floutage (9 novembre 2026) : une zone devient plusieurs segments, la limite passe à 500.
ALTER TABLE core.reblur_requests DROP CONSTRAINT reblur_requests_zones_check;
ALTER TABLE core.reblur_requests ADD CONSTRAINT reblur_requests_zones_check
    CHECK (jsonb_typeof(zones) = 'array' AND jsonb_array_length(zones) BETWEEN 1 AND 500);
