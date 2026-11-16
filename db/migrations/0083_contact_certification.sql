-- Formulaire de contact : demande d'un code pour certifier un compte (10 novembre 2026). Mail obligatoire pour pouvoir répondre.
ALTER TABLE core.contact_messages
    DROP CONSTRAINT contact_messages_reason_check,
    DROP CONSTRAINT contact_messages_check,
    ADD CONSTRAINT contact_messages_reason_check
        CHECK (reason IN ('content', 'right_of_reply', 'personal_data', 'authority', 'press', 'certification', 'other')),
    ADD CONSTRAINT contact_messages_check
        CHECK (reason NOT IN ('right_of_reply', 'personal_data', 'certification') OR email_enc IS NOT NULL);
