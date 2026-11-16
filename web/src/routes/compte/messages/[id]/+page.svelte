<script lang="ts">
  // Conversation d'un compte vérifié (journaliste, avocat, association) avec la source d'une vidéo.
  import { surveiller } from '#lib/surveiller.ts';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { dechiffrerOriginal, lecteurBlob, ouvrirPartageOriginalAvecEmpreinte, type MessageChiffre, type PourCompte } from 'argos-navigateur';
  import { ErreurApi, get, post } from '#lib/api.ts';
  import Conversation, { type MessageRecu } from '#lib/composants/Conversation.svelte';
  import DeverrouillerMessagerie from '#lib/composants/DeverrouillerMessagerie.svelte';
  import { confirmer } from '#lib/confirmer.svelte.ts';
  import { message } from '#lib/erreurs.ts';
  import { cleMessagerie, rafraichir } from '#lib/session.svelte.ts';

  interface Detail { id: string; ouverte: boolean; cleAutre: string | null; messages: MessageRecu[]; video: string; pseudonyme: string;
                    partage: { le: string; telechargeLe: string | null } | null }
  let d = $state<Detail | null>(null);
  let erreur = $state('');
  const id = $derived(page.params.id!);

  async function charger() {
    try {
      d = await get<Detail>(`/messagerie/${id}`);
      void rafraichir();   // compteur des non-lus
    } catch (x) {
      if (x instanceof ErreurApi && x.statut === 401) return goto('/connexion');
      erreur = message(x);
    }
  }
  $effect(() => { void id; void charger(); });
  $effect(() => surveiller(charger, 15_000));   // nouveaux messages sans recharger la page

  const envoyer = async (m: MessageChiffre) => { await post(`/messagerie/${id}`, { message: m }); await charger(); };
  // L'original partagé par la source : téléchargé chiffré, déchiffré ici, empreinte vérifiée, puis enregistré.
  let telechargement = $state<{ etape: string; url?: string; nom?: string } | null>(null);
  async function telecharger() {
    erreur = '';
    try {
      telechargement = { etape: 'Préparation…' };
      const o = await post<{ enveloppe: PourCompte; sha256Original: string; lien: string }>(`/messagerie/${id}/original`);
      const { cle, cleEmpreinte } = await ouvrirPartageOriginalAvecEmpreinte(o.enveloppe, cleMessagerie.ouverte!, o.sha256Original);
      telechargement = { etape: 'Téléchargement du fichier chiffré…' };
      const rep = await fetch(`/api${o.lien}`, { credentials: 'same-origin' });
      if (!rep.ok) throw new Error('Téléchargement impossible. Réessayez.');
      const chiffre = await rep.blob();
      telechargement = { etape: 'Déchiffrement dans votre navigateur…' };
      const morceaux: Uint8Array<ArrayBuffer>[] = [];
      const r = await dechiffrerOriginal(lecteurBlob(chiffre), cle, async (m) => { morceaux.push(m as Uint8Array<ArrayBuffer>); }, cleEmpreinte);
      // Empreinte clée (H10), ou SHA-256 simple pour une vidéo d'avant : vérifiée ici, dans le navigateur.
      if (!r.correspond(o.sha256Original)) throw new Error('Le fichier ne correspond pas à l’original : téléchargement refusé.');
      // Type de fichier d'après ses premiers octets (MP4/MOV ou WebM).
      const debut = morceaux[0] ?? new Uint8Array();
      const marque = new TextDecoder().decode(debut.slice(4, 12));
      const ext = debut[0] === 0x1a && debut[1] === 0x45 ? 'webm' : marque.includes('qt') ? 'mov' : 'mp4';
      const url = URL.createObjectURL(new Blob(morceaux, { type: ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : 'video/mp4' }));
      telechargement = { etape: 'Prêt', url, nom: `original-${d!.pseudonyme}.${ext}` };
      await charger();
    } catch (x) {
      telechargement = null;
      erreur = x instanceof Error && !('code' in x) ? x.message : message(x);
    }
  }

  async function fermer() {
    if (!(await confirmer({ titre: 'Fermer cette conversation ?', texte: 'Personne ne pourra plus y écrire. Elle ne pourra pas être rouverte.',
                            oui: 'Fermer la conversation', ton: 'danger' }))) return;
    try { await post(`/messagerie/${id}/fermer`); await charger(); } catch (x) { erreur = message(x); }
  }
</script>

<svelte:head><title>Conversation — Argos Veille</title></svelte:head>

<div class="conteneur texte-long">
  <span class="surtitre">Messagerie</span>
  <h1>{d ? `Source de ${d.pseudonyme}` : 'Conversation'}</h1>
  <div class="blocs">
    <p class="petit"><a href="/compte/messages">← Tous les messages</a>{#if d} · <a href="/videos/{d.video}">Voir la fiche de la vidéo</a>{/if}</p>
    <p class="second petit">La source reste anonyme : vous ne voyez que le nom de la vidéo. Messages chiffrés de bout en bout.</p>
    {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}
    {#if d}
      {#if !cleMessagerie.ouverte}
        <DeverrouillerMessagerie ouverte={() => {}} />
      {:else}
        {#if d.partage}
          <section class="carte">
            <h2>L’original non flouté</h2>
            <p class="second petit">La source vous l’a transmis. Déchiffré dans votre navigateur.</p>
            {#if telechargement?.url}
              <a class="bouton principal" href={telechargement.url} download={telechargement.nom}>Enregistrer la vidéo</a>
            {:else if telechargement}
              <p class="petit">{telechargement.etape}</p>
            {:else}
              <button class="bouton principal" onclick={telecharger}>Télécharger l’original</button>
            {/if}
          </section>
        {/if}
        <Conversation conversation={d.id} moi="verified" cle={cleMessagerie.ouverte} cleAutre={d.cleAutre} messages={d.messages}
                      ouverte={d.ouverte} nomAutre="La source" {envoyer}
                      fermee="Cette conversation est fermée (par la source ou par vous)."
                      signaler={async (message, cle) => { await post(`/messagerie/${id}/signaler`, { message, ...(cle ? { cle } : {}) }); }} />
        {#if d.ouverte}<p class="petit"><button class="bouton lien fermer" onclick={fermer}>Fermer cette conversation</button></p>{/if}
      {/if}
    {/if}
  </div>
</div>

<style>
  .blocs { display: grid; gap: 1.25rem; }
  .blocs > p { margin: 0; }
  .fermer { color: var(--danger); }
</style>
