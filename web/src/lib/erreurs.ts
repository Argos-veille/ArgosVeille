// Messages affichés pour les codes d'erreur de l'API.
import { ErreurApi } from './api.ts';

const MESSAGES: Record<string, string> = {
  reseau: 'Le site ne répond pas. Vérifiez votre connexion, puis réessayez.',
  erreur_interne: 'Une erreur est survenue de notre côté. Réessayez dans un moment ; si cela continue, utilisez le bouton « Signaler un bug » en bas de page.',
  erreur_inconnue: 'Une erreur inattendue est survenue.',
  requete_invalide: 'La demande n’a pas pu être traitée : vérifiez les champs.',
  client_perime: 'Le site a été mis à jour : rechargez la page, puis recommencez.',
  trop_de_demandes: 'Trop de tentatives. Patientez un peu avant de réessayer.',
  turnstile: 'La vérification anti-robot a échoué. Rechargez la page et réessayez.',
  passe_expire: 'La vérification anti-robot a expiré : rechargez la page pour en refaire une.',
  acces_beta: 'Votre accès à la bêta n’est plus valable.',
  // Messagerie avec les sources.
  deja_rattachee: 'Cette vidéo est déjà rattachée à un compte.',
  contact_refuse: 'La source n’accepte pas (ou plus) d’être contactée.',
  conversation_fermee: 'Cette conversation est fermée.',
  conversation_admin: 'Une conversation avec l’administration ne peut pas être fermée.',
  compte_non_verifie: 'Réservé aux comptes vérifiés (journalistes, avocats, associations).',
  trop_de_conversations: 'Trop de nouvelles conversations aujourd’hui. Réessayez demain.',
  cle_absente: 'Votre interlocuteur doit se reconnecter avant de pouvoir recevoir un message.',
  cle_existante: 'La messagerie de ce compte est déjà prête.',
  cle_messagerie_requise: 'Rechargez la page, puis recommencez le changement de mot de passe.',
  compte_sans_messagerie: 'Déverrouillez d’abord votre messagerie.',
  source_sans_messagerie: 'Cette vidéo a été envoyée avant la messagerie : personne ne peut y écrire.',
  video_indisponible: 'Cette vidéo n’est plus disponible.',
  cle_message_invalide: 'Ce message n’a pas pu être vérifié.',
  message_deja_signale: 'Ce message est déjà signalé.',
  message_chiffre_invalide: 'Le message n’a pas pu être chiffré correctement. Rechargez la page et réessayez.',
  session_en_cours: 'Pour fermer la session de cet appareil, utilisez « Se déconnecter ».',
  pas_de_partage: 'La source ne vous a pas (ou plus) transmis l’original.',
  deja_telecharge: 'L’original a déjà été téléchargé : le partage ne peut plus être retiré.',
  enveloppe_invalide: 'La transmission n’a pas pu être préparée. Rechargez la page et réessayez.',
  code_beta_invalide: 'Ce code n’est pas valable (ou plus valable).',
  code_invitation_invalide: 'Ce code d’invitation n’est pas valable (inconnu, expiré ou déjà utilisé). Laissez le champ vide si vous n’en avez pas.',
  code_encore_actif: 'Ce code est encore valable : révoquez-le avant de le supprimer.',
  expiration_passee: 'La date d’expiration est déjà passée.',
  conditions_perimees: 'Les conditions d’utilisation viennent de changer : rechargez la page, relisez-les et acceptez-les.',
  turnstile_requis: 'Une vérification anti-robot est nécessaire après plusieurs échecs.',
  non_connecte: 'Votre session a expiré. Reconnectez-vous.',
  origine_refusee: 'Demande refusée (origine inattendue).',

  // Inscription
  pseudo_invalide: 'Pseudo invalide : 3 à 30 caractères, lettres sans accents, chiffres, point, tiret ou tiret bas.',
  pseudo_interdit: 'Ce pseudo n’est pas accepté. Choisissez-en un autre.',
  pseudo_pris: 'Ce pseudo est déjà pris.',
  mdp_trop_court: 'Le mot de passe doit faire au moins 12 caractères.',
  mdp_trop_long: 'Le mot de passe est trop long.',
  mdp_courant: 'Ce mot de passe fait partie des plus courants : choisissez-en un autre.',
  mdp_contient_pseudo: 'Le mot de passe ne doit pas contenir votre pseudo.',
  mdp_repetitif: 'Le mot de passe est trop répétitif.',
  telephone_invalide: 'Numéro de téléphone invalide.',
  telephone_ambigu: 'Numéro ambigu : écrivez-le en entier, par exemple 06 12 34 56 78.',
  telephone_non_mobile: 'Il faut un numéro de mobile (pour recevoir le SMS).',
  telephone_pays: 'Seuls les numéros français (métropole et outre-mer) sont acceptés pour l’instant.',
  mail_invalide: 'Adresse mail invalide.',
  lien_non_pris_en_charge: 'Ce site n’est pas pris en charge : téléchargez la vidéo et envoyez le fichier.',
  origine_invalide: 'Origine incomplète : pour citer quelqu’un, indiquez son nom.',
  adresse_indisponible: 'La recherche d’adresse est momentanément indisponible.',
  mail_requis: 'Indiquez une adresse mail pour que nous puissions vous répondre.',
  message_trop_court: 'Votre message est trop court (10 caractères au moins).',
  deja_inscrit: 'Ce numéro ou cette adresse est déjà inscrit. Vous pouvez récupérer votre compte : « Mot de passe oublié » sur la page de connexion.',
  refuse: 'Inscription impossible.',
  sms_indisponible: 'L’envoi de SMS est momentanément suspendu. Réessayez plus tard.',
  envoi_impossible: 'Le SMS ou le mail n’a pas pu être envoyé. Réessayez.',
  inscription_expiree: 'Cette inscription a expiré (30 minutes). Recommencez.',
  code_faux: 'Code incorrect.',
  trop_d_essais: 'Trop d’essais : recommencez depuis le début.',
  lien_invalide: 'Ce lien n’est pas valable, ou a déjà servi.',

  // Connexion et double authentification
  identifiants_incorrects: 'Pseudo ou mot de passe incorrect.',
  compte_banni: 'Ce compte a été exclu.',
  compte_suspendu: 'Ce compte est suspendu.',
  compte_inactif: 'Ce compte n’est pas actif.',
  attente_expiree: 'Le délai est dépassé. Reconnectez-vous.',
  code_invalide: 'Code incorrect.',
  aucune_cle: 'Aucune clé de sécurité n’est enregistrée sur ce compte.',
  cle_invalide: 'La clé de sécurité n’a pas été reconnue.',
  mot_de_passe_incorrect: 'Mot de passe incorrect.',
  deja_active: 'Une application d’authentification est déjà active.',
  deja_enregistree: 'Cette clé est déjà enregistrée.',
  activation_expiree: 'Le délai d’activation est dépassé. Recommencez.',
  introuvable: 'Introuvable.',

  // Administration
  session_admin_requise: 'La session d’administration est fermée. Rouvrez-la avec votre clé physique.',
  reserve_super_admin: 'Réservé au super-administrateur.',
  super_admin_administration_seulement: 'Ce compte se connecte seulement sur l’administration. Si vous venez de taper son mot de passe ici, changez-le depuis l’administration.',
  cle_requise: 'Enregistrez d’abord une clé physique dans « Mon compte ».',
  video_hors_decision: 'Cette vidéo n’attend plus de décision.',
  motif: 'Indiquez un motif (au moins quelques mots).',
  action_impossible: 'Action impossible dans l’état actuel de la vidéo.',
  deja_signale: 'Vous avez déjà signalé cette vidéo : l’administration l’examine.',
  trop_de_signalements: 'Vous avez envoyé beaucoup de signalements aujourd’hui. Réessayez demain.',
  details: 'Précisez le problème en quelques mots (2 000 caractères au plus).',
  motif_inconnu: 'Motif inconnu.',
  deja_ainsi: 'C’est déjà le cas.',
  aucune_conversation: 'Vous pourrez répondre quand l’administration vous aura écrit.',
  message_invalide: 'Le message est vide ou trop long (5 000 caractères au plus).',
  trop_de_messages: 'Vous avez envoyé beaucoup de messages aujourd’hui. Réessayez demain.',

  // Récupération
  lien_expire: 'Ce lien a expiré ou a déjà servi. Faites une nouvelle demande.',

  // Relecture et jury
  relecture_terminee: 'La relecture de cette vidéo est terminée.',
  places_prises: 'Toutes les places de relecture sont déjà prises pour cette vidéo. Merci quand même !',
  plafond_journalier: 'Vous avez atteint vos 5 relectures des dernières 24 heures. Revenez demain.',
  justification: 'Expliquez en quelques mots (10 caractères au moins).',
  fiche_introuvable: 'Fiche introuvable : indiquez le nom ou le lien d’une vidéo publiée.',
  deja_tranchee: 'Ces deux vidéos ont déjà fait l’objet d’une décision.',
  propre_proposition: 'Vous ne pouvez pas donner votre avis sur votre propre proposition.',
  double_auth_requise: 'Il faut une double authentification active : ajoutez-en une dans « Mon compte ».',
  derniere_methode: 'C’est votre dernière méthode de double authentification : elle est obligatoire pour votre compte. Ajoutez-en une autre avant de la retirer.',
  verdict_invalide: 'Le jury répond oui ou non.',
  raisons_contradictoires: 'Deux raisons cochées se contredisent : retirez-en une.',
  raisons_invalides: 'Choisissez au moins une raison qui corresponde à votre réponse.',
  video_pas_encore_vue: 'Regardez d’abord la vidéo en entier : la réponse et les notes s’ouvrent ensuite.',
  propre_note: 'Vous ne pouvez pas juger votre propre note.',
  // Analystes
  reserve_analyste: 'Réservé aux analystes OSINT vérifiés.',
  video_hors_relecture: 'Cette vidéo n’est plus en relecture.',
  plafond_notes: 'Vous avez déjà 3 notes sur cette vidéo : corrigez-en une, ou retirez-la.',
  note_invalide: 'Le constat (200 caractères au plus) et l’explication (5 000 au plus) sont obligatoires.',
  liens_invalides: 'Chaque lien doit commencer par https:// (1 à 10 liens, adresses complètes).',
  lien_expire_video: 'Le lien de visionnage a expiré : rechargez la vidéo.',

  // Envoi et suivi
  lieu_hors_de_france: 'Le lieu doit se trouver en France (métropole ou outre-mer).',
  date_invalide: 'La date des faits n’est pas valable (dans le futur ?).',
  envois_satures: 'Trop d’envois en ce moment : réessayez dans une heure.',
  serveur_plein: 'Le serveur est momentanément plein : réessayez dans quelques heures.',
  phrase_deja_utilisee: 'Ce code de suivi a déjà servi : revenez à l’étape précédente pour en créer un nouveau.',
  contexte_invalide: 'La description est incomplète ou incohérente.',
  fichier_invalide: 'Ce fichier n’est pas une vidéo lisible.',
  morceaux_manquants: 'Une partie de la vidéo n’est pas arrivée : réessayez.',
  envoi_introuvable: 'Cet envoi n’existe plus (plus de 24 h ?) : recommencez.',
  taille_de_morceau: 'Une partie de la vidéo est arrivée abîmée : réessayez.',
  pas_de_version_floutee: 'La version floutée n’est pas encore prête.',
  zone_invalide: 'Une zone tracée n’est pas valable (trop petite, ou fin avant le début).',
  retouches_epuisees: 'Les 10 retouches sont utilisées : validez la vidéo, ou retirez-la.',
  non_retouchable: 'Cette vidéo ne peut plus être retouchée (copie de travail expirée).',
  piste_inconnue: 'Un visage de la liste n’existe plus : rechargez la page.',
  cle_copie: 'Le code ne correspond pas à cette vidéo : reconnectez-vous avec votre code de 12 mots.',
  pas_a_verifier: 'La vidéo n’est plus à vérifier.',
  confirmation: 'Le nom de la vidéo ne correspond pas : retapez-le exactement.',
  retrait_bloque: 'Cette vidéo fait l’objet d’une procédure : elle ne peut pas être retirée pour l’instant.',
  deja_retiree: 'Cette vidéo est déjà retirée.',

  // Bugs
  theme_inconnu: 'Choisissez un thème dans la liste.',
  trop_volumineux: 'Trop volumineux (la capture d’écran, sans doute).',
};

export function message(e: unknown): string {
  if (e instanceof ErreurApi) {
    if (e.code === 'code_faux' || e.code === 'code_invalide') {
      const reste = e.corps['essaisRestants'];
      return typeof reste === 'number' ? `Code incorrect. Encore ${reste} essai${reste > 1 ? 's' : ''}.` : MESSAGES['code_invalide']!;
    }
    if (e.code === 'video_pas_encore_vue' && typeof e.corps['disponibleDans'] === 'number' && e.corps['disponibleDans'] > 0) {
      return `Regardez d’abord la vidéo en entier : encore ${e.corps['disponibleDans']} s avant de pouvoir répondre.`;
    }
    if (e.code === 'limite_envois') {
      const n = Number(e.corps['limite'] ?? 5);
      const s = Number(e.corps['disponibleDans'] ?? 0);
      const quand = s > 0
        ? ` Vous pourrez en envoyer à nouveau ${s >= 3600 ? `dans environ ${Math.ceil(s / 3600)} h` : `dans ${Math.max(1, Math.ceil(s / 60))} min`}.`
        : '';
      return `Limite atteinte : ${n} envois de vidéo par heure, pour éviter les abus.${quand}`
        + ' Les vidéos déjà envoyées ne sont pas concernées.';
    }
    if (e.code === 'compte_suspendu' && typeof e.corps['jusquau'] === 'string') {
      return `Ce compte est suspendu jusqu’au ${new Date(e.corps['jusquau']).toLocaleString('fr-FR')}.`;
    }
    return MESSAGES[e.code] ?? `${MESSAGES['erreur_inconnue']} (${e.code})`;
  }
  if (e instanceof Error && e.name === 'NotAllowedError') return 'Opération annulée, ou délai dépassé.';
  if (e instanceof Error && e.message === 'turnstile_indisponible') {
    return 'La vérification anti-robot n’a pas pu se charger (bloqueur de contenu, réseau ?). Réessayez.';
  }
  if (e instanceof Error && e.message.startsWith('turnstile')) return 'La vérification anti-robot a échoué. Réessayez.';
  return MESSAGES['erreur_inconnue']!;
}
