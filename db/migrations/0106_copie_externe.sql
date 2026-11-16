-- Revue de sécurité B13 (14 novembre 2026) : copie des sauvegardes tirée par un serveur à part de l’administration,
-- hors du stockage des sauvegardes. Le serveur de copie signale ici chaque passage (réussi ou non) ; le tableau de bord de l'administration
-- l'affiche, en alerte s'il manque plus de 30 heures. Une seule ligne, sans aucune donnée personnelle.
CREATE TABLE core.external_copy (
    id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    received_at timestamptz NOT NULL,
    ok          boolean NOT NULL,
    detail      text CHECK (char_length(detail) <= 300)
);
REVOKE ALL ON core.external_copy FROM PUBLIC;

CREATE FUNCTION core.external_copy_record(p_ok boolean, p_detail text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    INSERT INTO core.external_copy (id, received_at, ok, detail) VALUES (1, now(), p_ok, left(p_detail, 300))
    ON CONFLICT (id) DO UPDATE SET received_at = EXCLUDED.received_at, ok = EXCLUDED.ok, detail = EXCLUDED.detail;
$$;

CREATE FUNCTION core.admin_external_copy() RETURNS TABLE (received_at timestamptz, ok boolean, detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT received_at, ok, detail FROM core.external_copy WHERE id = 1;
$$;

REVOKE ALL ON FUNCTION core.external_copy_record(boolean, text), core.admin_external_copy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.external_copy_record(boolean, text) TO argos_app;
GRANT EXECUTE ON FUNCTION core.admin_external_copy() TO argos_administration;
