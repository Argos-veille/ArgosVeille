-- Second audit (15 novembre 2026, A1) : les comptes à double authentification obligatoire (super-administrateur, analyste,
-- journaliste, avocat, association, compte de confiance) ne peuvent plus garder d'« appareil de confiance ». Leurs sessions
-- déjà ouvertes ont pu l'être SANS second facteur grâce à lui : elles sont fermées une fois (décision de l’administrateur), et les
-- appareils de confiance déjà accordés effacés. Chacun se reconnecte une fois, avec sa double authentification.
UPDATE core.sessions s SET revoked_at = now()
 WHERE s.revoked_at IS NULL
   AND (EXISTS (SELECT 1 FROM core.accounts a WHERE a.id = s.account_id AND a.is_superadmin)
        OR EXISTS (SELECT 1 FROM core.verifications v WHERE v.account_id = s.account_id AND v.revoked_at IS NULL
                     AND v.expires_at > now()));
UPDATE core.known_devices d SET mfa_trusted_until = NULL
 WHERE d.mfa_trusted_until IS NOT NULL
   AND (EXISTS (SELECT 1 FROM core.accounts a WHERE a.id = d.account_id AND a.is_superadmin)
        OR EXISTS (SELECT 1 FROM core.verifications v WHERE v.account_id = d.account_id AND v.revoked_at IS NULL
                     AND v.expires_at > now()));
DELETE FROM core.admin_sessions;
