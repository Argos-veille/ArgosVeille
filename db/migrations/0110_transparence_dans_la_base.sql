-- Point bas de la revue (15 novembre 2026) : les règles d'anonymat du rapport de transparence n'étaient appliquées que
-- par le site. La base les applique maintenant elle-même :
--   - seulement un trimestre entier et TERMINÉ (un compteur sur une courte période permettrait de dater une action) ;
--   - 1 à 4 → « <5 » ; dans une répartition, si une seule case est masquée, la plus petite autre l'est aussi ;
--   - délai médian seulement s'il porte sur au moins 5 décisions.
-- Les fonctions de comptage d'origine deviennent internes (aucun accès du site).

ALTER FUNCTION core.transparency_report(date, date) RENAME TO transparency_report_raw;
ALTER FUNCTION core.transparency_authority(date, date) RENAME TO transparency_authority_raw;
REVOKE ALL ON FUNCTION core.transparency_report_raw(date, date), core.transparency_authority_raw(date, date) FROM argos_app;
ALTER FUNCTION core.transparency_report_raw(date, date) SET search_path = core, public, pg_temp;
ALTER FUNCTION core.transparency_authority_raw(date, date) SET search_path = core, public, pg_temp;

-- Un trimestre entier, terminé (heure de Paris).
CREATE FUNCTION core.transparency_check_period(p_from date, p_to date) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF p_from IS NULL OR p_to IS NULL OR p_from <> date_trunc('quarter', p_from)::date
       OR p_to <> (p_from + interval '3 months')::date OR p_to > (now() AT TIME ZONE 'Europe/Paris')::date THEN
        RAISE EXCEPTION 'argos:periode_invalide';
    END IF;
END $$;

CREATE FUNCTION core.transparency_mask(n bigint) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
    SELECT CASE WHEN n BETWEEN 1 AND 4 THEN '"<5"'::jsonb ELSE to_jsonb(coalesce(n, 0)) END
$$;

-- Une répartition { code: nombre } masquée, avec le masquage secondaire.
CREATE FUNCTION core.transparency_mask_split(r jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
    WITH c AS (SELECT key, value::bigint AS n FROM jsonb_each_text(coalesce(r, '{}'))),
         masquees AS (SELECT count(*) AS m FROM c WHERE n BETWEEN 1 AND 4),
         seconde AS (SELECT key FROM c, masquees WHERE m = 1 AND n > 4 ORDER BY n, key LIMIT 1)
    SELECT coalesce(jsonb_object_agg(c.key, CASE WHEN c.key IN (SELECT key FROM seconde) THEN '"<5"'::jsonb
                                                 ELSE core.transparency_mask(c.n) END), '{}')
      FROM c
$$;

CREATE FUNCTION core.transparency_report(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    b jsonb;
BEGIN
    PERFORM core.transparency_check_period(p_from, p_to);
    b := core.transparency_report_raw(p_from, p_to);
    RETURN jsonb_build_object(
        'envois', jsonb_build_object(
            'recues', core.transparency_mask((b #>> '{envois,recues}')::bigint),
            'echecs', core.transparency_mask((b #>> '{envois,echecs}')::bigint),
            'retireesParLaSource', core.transparency_mask((b #>> '{envois,retireesParLaSource}')::bigint)),
        'decisions', jsonb_build_object(
            'parResultat', core.transparency_mask_split(b #> '{decisions,parResultat}'),
            'parQui', core.transparency_mask_split(b #> '{decisions,parQui}'),
            'delaiMedianJours', CASE WHEN (b #>> '{decisions,delaiNombre}')::bigint >= 5 THEN b #> '{decisions,delaiMedianJours}'
                                     ELSE 'null'::jsonb END),
        'signalements', jsonb_build_object(
            'parMotif', core.transparency_mask_split(b #> '{signalements,parMotif}'),
            'parSuite', core.transparency_mask_split(b #> '{signalements,parSuite}')),
        'retraits', core.transparency_mask_split(b -> 'retraits'),
        'corrections', core.transparency_mask((b ->> 'corrections')::bigint),
        'changementsDeRegles', core.transparency_mask((b ->> 'changementsDeRegles')::bigint),
        'sanctions', core.transparency_mask_split(b -> 'sanctions'),
        'originaux', jsonb_build_object(
            'parAdministration', core.transparency_mask_split(b #> '{originaux,parAdministration}'),
            'parLaSource', core.transparency_mask_split(b #> '{originaux,parLaSource}'),
            'ouverturesParAdministration', core.transparency_mask((b #>> '{originaux,ouverturesParAdministration}')::bigint)));
END $$;

CREATE FUNCTION core.transparency_authority(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    b jsonb;
BEGIN
    PERFORM core.transparency_check_period(p_from, p_to);
    b := core.transparency_authority_raw(p_from, p_to);
    RETURN jsonb_build_object('parAuteur', core.transparency_mask_split(b -> 'parAuteur'),
                              'parObjet', core.transparency_mask_split(b -> 'parObjet'),
                              'parSuite', core.transparency_mask_split(b -> 'parSuite'));
END $$;

REVOKE ALL ON FUNCTION core.transparency_check_period(date, date), core.transparency_mask(bigint),
                       core.transparency_mask_split(jsonb), core.transparency_report(date, date),
                       core.transparency_authority(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.transparency_report(date, date), core.transparency_authority(date, date) TO argos_app;
