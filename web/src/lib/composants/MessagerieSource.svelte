<script lang="ts">
  // Messagerie de la source, dans le suivi de sa vidéo : accepter ou non d'être contactée par des comptes vérifiés
  // (journalistes, avocats, associations), lire et répondre (aussi à l'administration), fermer une conversation.
  // La clé de la vidéo s'ouvre avec les 12 mots (suivi par le code) ou avec la clé du compte (envoi avec compte).
  import Manque from '#lib/composants/Manque.svelte';
  import { surveiller } from '#lib/surveiller.ts';
  import { CLE_MESSAGERIE_ADMIN } from '#lib/cle-messagerie-admin.ts';
  import { cleOriginalBrute, lirePhrase, ouvrirCleVideoParCompte, ouvrirCleVideoParPhrase, partagerOriginal, type CleOuverte, type CleVideo, type MessageChiffre, trouverEntropie } from 'argos-navigateur';
  import Conversation, { type MessageRecu } from '#lib/composants/Conversation.svelte';
  import DeverrouillerMessagerie from '#lib/composants/DeverrouillerMessagerie.svelte';
  import Info from '#lib/composants/Info.svelte';
  import { confirmer } from '#lib/confirmer.svelte.ts';
  import { message } from '#lib/erreurs.ts';
  import { cleMessagerie } from '#lib/session.svelte.ts';

  let { appel, entropie, parCompte, recente }: {
    appel: <T>(chemin: string, corps?: object) => Promise<T>;
    entropie?: Uint8Array;      // les 12 mots, si le suivi a été ouvert avec le code
    parCompte: boolean;
    recente: boolean;           // vidéo encore en floutage ou à vérifier : la carte n'apparaît que s'il y a des messages
  } = $props();

  interface Ligne { id: string; admin: boolean; ouverte: boolean; dernier: string; nonLu: boolean;
                    avec: { statut: string | null; libelle: string; pseudo: string | null } }
  let etat = $state<{ contact: boolean; cle: CleVideo | null; conversations: Ligne[]; sha256Original: string | null } | null>(null);
  let cleVideo = $state<CleOuverte | null>(null);
  let ouverteId = $state<string | null>(null);
  let detail = $state<{ id: string; admin: boolean; ouverte: boolean; cleAutre: string | null; messages: MessageRecu[];
                        partage: { le: string; telechargeLe: string | null } | null } | null>(null);
  // Clé de l'interlocuteur à utiliser : pour l'Administration, SEULEMENT la clé épinglée dans le code du site (N2) ; une
  // autre clé renvoyée par le serveur est refusée (rien n'est chiffré pour elle).
  // En production, tant que la clé n'est pas épinglée, rien n'est écrit à l'Administration (aucune clé n'est crue).
  const adminSansEpingle = import.meta.env.PROD && !CLE_MESSAGERIE_ADMIN;
  const cleAutreSure = $derived(!detail?.cleAutre ? null
    : detail.admin && (adminSansEpingle || (CLE_MESSAGERIE_ADMIN && detail.cleAutre !== CLE_MESSAGERIE_ADMIN)) ? null : detail.cleAutre);
  const cleAdminRefusee = $derived(!!detail?.admin && !!detail.cleAutre
    && (adminSansEpingle || (!!CLE_MESSAGERIE_ADMIN && detail.cleAutre !== CLE_MESSAGERIE_ADMIN)));
  // Transmettre l'original : les 12 mots sont la seule clé de l'original (à retaper s'ils ne sont pas déjà connus).
  let partageOuvert = $state(false);
  let motsPartage = $state('');
  let mots = $state('');
  let erreur = $state('');
  let occupe = $state(false);

  async function charger() {
    etat = await appel('/suivi/messagerie');
    if (ouverteId) detail = await appel('/suivi/messagerie/lire', { conversation: ouverteId });
  }
  $effect(() => { void charger().catch((x) => (erreur = message(x))); });
  // Nouveaux messages sans recharger la page : toutes les 15 secondes, onglet visible seulement.
  $effect(() => surveiller(charger, 15_000));

  // Ouvrir la clé de la vidéo dès que possible : 12 mots déjà connus, ou clé du compte déjà déverrouillée.
  $effect(() => {
    const c = etat?.cle;
    if (!c || cleVideo) return;
    if (entropie) void ouvrirCleVideoParPhrase(c, entropie).then((k) => (cleVideo = k)).catch(() => {});
    else if (parCompte && c.pourCompte && cleMessagerie.ouverte) {
      void ouvrirCleVideoParCompte(c, cleMessagerie.ouverte).then((k) => (cleVideo = k)).catch(() => {});
    }
  });

  /** Un code peut servir à plusieurs vidéos : retrouve le secret de celle-ci (reconnu à sa clé de messagerie). */
  async function secretDeLaVideo(code: Uint8Array): Promise<Uint8Array> {
    const cle = etat?.cle;
    if (!cle) return code;
    return (await trouverEntropie(code, (e) => ouvrirCleVideoParPhrase(cle, e).then(() => true, () => false))) ?? code;
  }

  async function parMots(e: SubmitEvent) {
    e.preventDefault();
    erreur = '';
    const lu = await lirePhrase(mots);
    if (!lu.ok || !etat?.cle) { erreur = 'Code de 12 mots illisible : vérifiez les mots.'; return; }
    const secret = await secretDeLaVideo(lu.entropie);
    try { cleVideo = await ouvrirCleVideoParPhrase(etat.cle, secret); mots = ''; }
    catch { erreur = 'Ce code n’est pas celui de cette vidéo.'; }
  }

  async function faire(f: () => Promise<unknown>) {
    erreur = ''; occupe = true;
    try { await f(); } catch (x) { erreur = message(x); } finally { occupe = false; }
  }
  const changerContact = () => faire(async () => {
    const r = await appel<{ contact: boolean }>('/suivi/messagerie/contact', { autoriser: !etat!.contact });
    etat!.contact = r.contact;
  });
  const ouvrir = (id: string) => faire(async () => {
    ouverteId = id;
    detail = await appel('/suivi/messagerie/lire', { conversation: id });
    await charger();
  });
  const envoyer = async (m: MessageChiffre) => {
    await appel('/suivi/messagerie/ecrire', { conversation: ouverteId, message: m });
    await charger();
  };
  const fermer = () => faire(async () => {
    if (!(await confirmer({ titre: 'Fermer cette conversation ?', texte: 'Personne ne pourra plus y écrire, ni vous ni votre interlocuteur. Elle ne pourra pas être rouverte.',
                            oui: 'Fermer la conversation', ton: 'danger' }))) return;
    await appel('/suivi/messagerie/fermer', { conversation: ouverteId });
    await charger();
  });
  const transmettre = () => faire(async () => {
    let e = entropie;
    if (!e) {
      const lu = await lirePhrase(motsPartage);
      if (!lu.ok) throw new Error('Code de 12 mots illisible : vérifiez les mots.');
      e = await secretDeLaVideo(lu.entropie);
    }
    if (!cleAutreSure || !etat?.sha256Original) throw new Error('Transmission impossible pour le moment.');
    if (!(await confirmer({ titre: 'Transmettre l’original non flouté ?',
                            texte: 'Une fois téléchargé, il ne peut plus être repris. Retirable d’ici là.',
                            oui: 'Transmettre', ton: 'danger' }))) return;
    const enveloppe = await partagerOriginal(await cleOriginalBrute(e), cleAutreSure, etat.sha256Original);
    await appel('/suivi/messagerie/partager', { conversation: ouverteId, enveloppe });
    partageOuvert = false; motsPartage = '';
    await charger();
  });
  const retirerPartage = () => faire(async () => {
    await appel('/suivi/messagerie/partage/retirer', { conversation: ouverteId });
    await charger();
  });

  const nom = (l: Ligne) => (l.admin ? l.avec.libelle : `${l.avec.libelle}${l.avec.pseudo ? ` — ${l.avec.pseudo}` : ''}`);
  const quand = (iso: string) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
</script>

{#if etat && (!recente || etat.conversations.length)}
  <section class="carte messagerie">
    <h2>Messages</h2>
    {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}
    {#if !etat.cle}
      <p class="second petit">Cette vidéo a été envoyée avant la messagerie : personne ne peut vous y écrire.</p>
    {:else}
      {#if !recente}
        <div class="ligne">
          <div>
            <strong>Accepter d’être contacté par des journalistes, avocats ou associations vérifiés</strong>
            <span class="statut" class:actif={etat.contact}>{etat.contact ? 'Oui' : 'Non'}</span>
            <Info>Ils ne voient que le nom de la vidéo, jamais votre compte. L’administration d’Argos Veille peut toujours vous
              écrire.</Info>
          </div>
          <button class="bouton" onclick={changerContact} disabled={occupe}>{etat.contact ? 'Ne plus accepter' : 'Accepter'}</button>
        </div>
      {/if}

      {#if etat.conversations.length}
        {#if !cleVideo}
          {#if parCompte && etat.cle.pourCompte && !cleMessagerie.ouverte}
            <DeverrouillerMessagerie ouverte={() => {}} />
          {:else}
            <form class="carte" onsubmit={parMots}>
              <h3>Ouvrir les messages</h3>
              <p class="second petit">Les messages de cette vidéo s’ouvrent avec son code de 12 mots.</p>
              <textarea rows="2" bind:value={mots} aria-label="Code de 12 mots" autocomplete="off" autocapitalize="none" spellcheck="false"></textarea>
              <Manque raisons={[!mots.trim() && 'les 12 mots du code']}><button class="bouton principal" disabled={!mots.trim()}>Ouvrir</button></Manque>
            </form>
          {/if}
        {:else if ouverteId && detail}
          <p class="petit"><button class="bouton lien" onclick={() => { ouverteId = null; detail = null; }}>← Toutes les conversations</button></p>
          {@const ligne = etat.conversations.find((c) => c.id === ouverteId)}
          <h3>{ligne ? nom(ligne) : 'Conversation'}</h3>
          {#if cleAdminRefusee}
            <div class="message erreur" role="alert">Conversation indisponible pour le moment. N’envoyez rien.</div>
          {/if}
          <Conversation conversation={detail.id} moi="witness" cle={cleVideo} cleAutre={cleAutreSure} messages={detail.messages} sansEmpreinte={detail.admin}
                        ouverte={detail.ouverte} nomAutre={ligne ? nom(ligne) : 'Votre interlocuteur'} {envoyer}
                        signaler={(message, cle) => appel('/suivi/messagerie/signaler', { conversation: ouverteId, message, ...(cle ? { cle } : {}) })} />
          {#if !detail.admin && etat.sha256Original}
            <div class="carte partage">
              <h3>L’original non flouté</h3>
              {#if detail.partage?.telechargeLe}
                <p class="second petit">Transmis : téléchargé le {quand(detail.partage.telechargeLe)}.</p>
              {:else if detail.partage}
                <p class="second petit">Partagé le {quand(detail.partage.le)}, pas encore téléchargé.</p>
                <button class="bouton" onclick={retirerPartage} disabled={occupe}>Retirer le partage</button>
              {:else if detail.ouverte && cleAutreSure}
                {#if !partageOuvert}
                  <button class="bouton" onclick={() => (partageOuvert = true)} disabled={occupe}>Lui transmettre l’original…</button>
                {:else}
                  {#if !entropie}
                    <label class="etiquette" for="mots-partage">Votre code de 12 mots</label>
                    <textarea id="mots-partage" rows="2" bind:value={motsPartage} autocomplete="off" autocapitalize="none" spellcheck="false"></textarea>
                  {/if}
                  <div class="boutons">
                    <Manque raisons={[!entropie && !motsPartage.trim() && 'les 12 mots du code']}><button class="bouton principal" onclick={transmettre} disabled={occupe || (!entropie && !motsPartage.trim())}>Continuer</button></Manque>
                    <button class="bouton lien" onclick={() => { partageOuvert = false; motsPartage = ''; }}>Annuler</button>
                  </div>
                {/if}
              {/if}
            </div>
          {/if}
          {#if detail.ouverte && !detail.admin}
            <p class="petit"><button class="bouton lien danger-texte" onclick={fermer} disabled={occupe}>Fermer cette conversation</button></p>
          {/if}
        {:else}
          <ul class="conversations">
            {#each etat.conversations as c (c.id)}
              <li>
                <button class="ligne-conv" onclick={() => ouvrir(c.id)}>
                  <span><strong>{nom(c)}</strong>{#if c.nonLu} <span class="pastille accent">nouveau</span>{/if}
                    {#if !c.ouverte} <span class="pastille">fermée</span>{/if}</span>
                  <span class="petit discret">{quand(c.dernier)}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <p class="second petit">Aucun message pour l’instant.</p>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .messagerie { display: grid; gap: 1rem; }
  .messagerie h2, .messagerie h3 { margin: 0; }
  .ligne { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .ligne > div { flex: 1 1 auto; min-width: 0; }
  @media (max-width: 30rem) { .ligne { flex-wrap: wrap; } }
  .statut { display: inline-block; margin-left: 0.5rem; font-size: 0.75rem; font-weight: 700; padding: 0.125rem 0.5rem;
            border-radius: 999px; color: var(--danger); background: var(--danger-doux); }
  .statut.actif { color: var(--succes); background: var(--succes-doux); }
  .conversations { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
  .ligne-conv { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 1rem; text-align: left;
                padding: 0.75rem 1rem; border: 1px solid var(--trait); border-radius: var(--rayon); background: var(--surface);
                color: inherit; font: inherit; cursor: pointer; }
  .ligne-conv:hover { border-color: var(--accent); }
  .danger-texte { color: var(--danger); }
  .partage { display: grid; gap: 0.5rem; margin: 0; }
  .partage h3 { margin: 0; font-size: 1rem; }
  textarea { width: 100%; }
</style>
