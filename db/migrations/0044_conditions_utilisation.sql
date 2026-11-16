-- Conditions d'utilisation (7 novembre 2026, validées par l’administrateur) : acceptées à chaque envoi et à
-- l'inscription. On garde la version acceptée (une date, ex. « 2026-11-07 ») : sur la vidéo pour un envoi
-- (avec ou sans compte), sur le compte pour un relecteur. Quand le texte change, la nouvelle version est
-- redemandée aux comptes (le site compare avec la version en vigueur).

ALTER TABLE core.videos ADD COLUMN terms_version text
    CONSTRAINT videos_terms_version CHECK (terms_version ~ '^\d{4}-\d{2}-\d{2}$');
GRANT INSERT (terms_version) ON core.videos TO argos_app;

ALTER TABLE core.accounts ADD COLUMN terms_version text
        CONSTRAINT accounts_terms_version CHECK (terms_version ~ '^\d{4}-\d{2}-\d{2}$'),
    ADD COLUMN terms_accepted_at timestamptz,
    ADD CONSTRAINT accounts_terms_ensemble CHECK ((terms_version IS NULL) = (terms_accepted_at IS NULL));
GRANT SELECT (terms_version) ON core.accounts TO argos_app;

-- Acceptation par un compte actif (à l'inscription, puis à chaque nouvelle version).
CREATE FUNCTION core.accept_terms(p_account uuid, p_version text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF p_version IS NULL OR p_version !~ '^\d{4}-\d{2}-\d{2}$' THEN
        RAISE EXCEPTION 'argos:version_invalide';
    END IF;
    UPDATE core.accounts SET terms_version = p_version, terms_accepted_at = now()
     WHERE id = p_account AND status = 'active';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:compte_inactif';
    END IF;
END $$;
REVOKE ALL ON FUNCTION core.accept_terms(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.accept_terms(uuid, text) TO argos_app;
