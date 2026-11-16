<script lang="ts" module>
  import Manque from '#lib/composants/Manque.svelte';
  export interface MessageRecu { id: string; de: 'witness' | 'verified'; le: string; chiffre: import('argos-navigateur').MessageChiffre }
</script>

<script lang="ts">
  // Une conversation chiffrée de bout en bout (messagerie avec les sources) : les messages sont déchiffrés ici,
  // avec la clé de la personne qui lit ; une réponse est chiffrée pour les deux parties avant de partir.
  import { chiffrerMessage, cleDuMessage, dechiffrerMessage, empreinteLongue, expediteurVerifie, TEXTE_MAX, type CleOuverte, type MessageChiffre } from 'argos-navigateur';
  import { message as messageErreur } from '#lib/erreurs.ts';

  let { conversation, moi, cle, cleAutre, messages, ouverte, nomAutre, envoyer, fermee = '', signaler, sansEmpreinte = false }: {
    conversation: string;
    moi: 'witness' | 'verified';            // côté de la personne qui lit
    cle: CleOuverte;                          // sa clé, ouverte
    cleAutre: string | null;                  // clé publique de l'autre partie (absente : elle doit se reconnecter)
    messages: MessageRecu[];
    ouverte: boolean;
    nomAutre: string;                         // « La source », « Journaliste — pseudo », « Administration »…
    envoyer: (m: MessageChiffre) => Promise<void>;
    fermee?: string;                          // texte affiché quand la conversation est fermée
    sansEmpreinte?: boolean;                  // conversation avec l'Administration : clé épinglée, rien à comparer
    // Signaler un message reçu ; `cle` : clé de CE message, si la personne accepte de le montrer à l'administration.
    signaler?: (message: string, cle?: string) => Promise<void>;
  } = $props();

  let aSignaler = $state<string | null>(null);
  let reveler = $state(true);
  let signales = $state<string[]>([]);
  async function confirmerSignalement(id: string) {
    erreur = '';
    try {
      const m = messages.find((x) => x.id === id)!;
      await signaler!(id, reveler ? await cleDuMessage(m.chiffre, conversation, m.de, cle) : undefined);
      signales = [...signales, id]; aSignaler = null;
    } catch (x) { erreur = messageErreur(x); }
  }

  // verifie : la preuve de l'expéditeur est bonne (N2) ; faux pour un message d'avant la preuve, ou fabriqué.
  let lus = $state<{ id: string; de: string; le: string; texte: string | null; verifie: boolean }[]>([]);
  let texte = $state('');
  let enCours = $state(false);
  let erreur = $state('');

  $effect(() => {
    const liste = messages;
    const k = cle;
    const autre = cleAutre;
    // Un message rejoué par le serveur (même nonce qu'un précédent) n'est pas « vérifié » une seconde fois.
    const vus = new Set<string>();
    const rejoue = liste.map((m) => { const r = vus.has(m.chiffre.nonce); vus.add(m.chiffre.nonce); return r; });
    void Promise.all(liste.map(async (m, i) => ({
      id: m.id, de: m.de, le: m.le,
      texte: await dechiffrerMessage(m.chiffre, conversation, m.de, k).catch(() => null),
      verifie: !rejoue[i] && !!autre && await expediteurVerifie(m.chiffre, conversation, m.de, k, autre),
    }))).then((r) => (lus = r));
  });

  const quand = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });

  // Empreinte de sécurité de l'interlocuteur (côté source, 128 bits) : à comparer avec celle qu'il publie ailleurs (son
  // site, ses réseaux). Si le serveur avait remplacé sa clé, elles différeraient. Rien n'est gardé sur l'appareil de la
  // source (une trace de la conversation y prouverait l'envoi). Pas d'empreinte pour l'Administration : clé épinglée.
  let empreinteAutre = $state('');
  $effect(() => {
    const c = cleAutre;
    if (moi !== 'witness' || !c || sansEmpreinte) { empreinteAutre = ''; return; }
    void empreinteLongue(c).then((e) => { empreinteAutre = e.toUpperCase().match(/.{4}/g)!.join(' '); });
  });

  async function repondre(e: SubmitEvent) {
    e.preventDefault();
    if (!cleAutre) return;
    erreur = ''; enCours = true;
    try {
      await envoyer(await chiffrerMessage(texte, conversation, moi, [cle.publique, cleAutre], { moi: cle, autre: cleAutre }));
      texte = '';
    } catch (x) {
      erreur = x instanceof Error && !('code' in x) ? x.message : messageErreur(x);
    } finally {
      enCours = false;
    }
  }
</script>

<div class="fil">
  {#each lus as m (m.id)}
    <article class="carte bulle" class:moi={m.de === moi}>
      <div class="petit discret">{m.de === moi ? 'Vous' : nomAutre} · {quand(m.le)}</div>
      {#if m.texte === null}
        <p class="discret">Message illisible avec cette clé.</p>
      {:else}
        <p>{m.texte}</p>
        {#if m.de !== moi && !m.verifie}
          <p class="petit attention-texte">Expéditeur non vérifié : ce message n’a pas pu être authentifié.</p>
        {/if}
      {/if}
      {#if signaler && m.de !== moi}
        {#if signales.includes(m.id)}
          <p class="petit discret">Message signalé à l’administration.</p>
        {:else if aSignaler === m.id}
          <div class="signalement">
            <label class="case"><input type="checkbox" bind:checked={reveler} />
              <span>Montrer ce message à l’administration (sinon, chiffré, elle ne peut pas le lire)</span></label>
            <div class="boutons">
              <button class="bouton danger" onclick={() => confirmerSignalement(m.id)}>Signaler</button>
              <button class="bouton lien" onclick={() => (aSignaler = null)}>Annuler</button>
            </div>
          </div>
        {:else}
          <button class="bouton lien petit signaler" onclick={() => { aSignaler = m.id; reveler = true; }}>Signaler ce message</button>
        {/if}
      {/if}
    </article>
  {:else}
    <p class="second petit">Aucun message pour l’instant.</p>
  {/each}
</div>

{#if empreinteAutre}
  <p class="petit second empreinte">Empreinte de ce compte : <code>{empreinteAutre}</code>. Comparez-la avec celle que cette
    personne publie ailleurs (son site, ses réseaux). Si elles ne sont pas identiques, n’envoyez rien.</p>
{/if}
{#if ouverte}
  {#if cleAutre}
    <form class="carte" onsubmit={repondre}>
      {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}
      <div class="champ">
        <label for="message-{conversation}">Votre message</label>
        <textarea id="message-{conversation}" rows="4" maxlength={TEXTE_MAX} bind:value={texte}></textarea>
        <span class="aide">Chiffré dans votre navigateur avant de partir : Argos Veille ne peut pas le lire.</span>
      </div>
      <Manque raisons={[!texte.trim() && 'un message']}><button class="bouton principal" disabled={enCours || !texte.trim()}>{enCours ? 'Envoi…' : 'Envoyer'}</button></Manque>
    </form>
  {:else}
    <p class="message info petit">Votre interlocuteur doit se reconnecter avant de pouvoir recevoir un nouveau message.</p>
  {/if}
{:else}
  <p class="message info petit">{fermee || 'Cette conversation est fermée.'}</p>
{/if}

<style>
  .fil { display: grid; gap: 0.75rem; }
  .bulle { margin: 0; }
  .bulle.moi { box-shadow: inset 3px 0 0 var(--trait-fort); }
  .bulle:not(.moi) { box-shadow: inset 3px 0 0 var(--accent); }
  .bulle p { margin: 0.375rem 0 0; white-space: pre-line; overflow-wrap: anywhere; }
  .signaler { margin-top: 0.375rem; padding: 0; color: var(--texte-2); }
  .signalement { margin-top: 0.5rem; }
  .attention-texte { color: var(--erreur, #b3261e); }
</style>
