-- Rapports de bug et journal des erreurs du serveur (étape interface I-1, 5 novembre 2026).
--
-- Un rapport est envoyé volontairement depuis le site : deux thèmes choisis dans des listes, une
-- description, et une télémétrie prise à l'instant de l'envoi, montrée à la personne avant qu'elle
-- l'envoie (version du site, navigateur, dernières actions et derniers appels avec leur numéro de
-- requête, erreurs du navigateur…). Jamais d'adresse IP, de cookie, d'adresse complète ni de texte
-- saisi. Le pseudo n'est joint que si la personne le veut, et jamais depuis une page des sources.
-- Le site ne peut qu'écrire un rapport, jamais le relire.
--
-- Les erreurs internes du serveur sont gardées 14 jours avec leur numéro de requête et leur trace,
-- sans adresse IP ni contenu de requête : le numéro joint à un rapport permet de les retrouver.

CREATE TABLE core.bug_reports (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at     timestamptz NOT NULL DEFAULT now(),
    theme          text NOT NULL CHECK (theme ~ '^[a-z_]{1,40}$'),
    subtheme       text NOT NULL CHECK (subtheme ~ '^[a-z_]{1,40}$'),
    urgent         boolean NOT NULL DEFAULT false,      -- sécurité et confidentialité
    description    text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 5000),
    page           text NOT NULL CHECK (length(page) BETWEEN 1 AND 200),   -- page générique (« /relecture/[convocation] »)
    source_page    boolean NOT NULL,                    -- envoyé depuis une page des sources
    telemetry      jsonb CHECK (telemetry IS NULL OR octet_length(telemetry::text) <= 200000),
    screenshot     bytea CHECK (screenshot IS NULL OR length(screenshot) <= 3 * 1024 * 1024),
    account_id     uuid REFERENCES core.accounts (id) ON DELETE SET NULL,
    status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'handled', 'dismissed')),
    CHECK (NOT source_page OR (account_id IS NULL AND screenshot IS NULL))
);
CREATE INDEX bug_reports_open ON core.bug_reports (urgent DESC, created_at) WHERE status = 'open';
REVOKE ALL ON core.bug_reports FROM PUBLIC;
GRANT INSERT ON core.bug_reports TO argos_app;

CREATE TABLE core.request_errors (
    id          bigserial PRIMARY KEY,
    request_id  uuid NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    method      text NOT NULL CHECK (length(method) <= 10),
    route       text NOT NULL CHECK (length(route) <= 200),   -- route générique, jamais l'adresse complète
    status      smallint NOT NULL,
    error_name  text CHECK (length(error_name) <= 200),
    message     text CHECK (length(message) <= 2000),
    stack       text CHECK (length(stack) <= 20000)
);
CREATE INDEX request_errors_request ON core.request_errors (request_id);
CREATE INDEX request_errors_age ON core.request_errors (created_at);
REVOKE ALL ON core.request_errors FROM PUBLIC;
GRANT INSERT ON core.request_errors TO argos_app;
GRANT USAGE ON SEQUENCE core.request_errors_id_seq TO argos_app;

-- Effacement après 14 jours (appelé chaque heure par le site).
CREATE FUNCTION core.purge_request_errors() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    WITH e AS (DELETE FROM core.request_errors WHERE created_at < now() - interval '14 days' RETURNING 1)
    SELECT count(*)::int FROM e
$$;
REVOKE ALL ON FUNCTION core.purge_request_errors() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.purge_request_errors() TO argos_app;
