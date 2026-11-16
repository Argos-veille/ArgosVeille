<script lang="ts">
  // Fiche d'administration d'une vidéo : la vidéo floutée, le contexte, l'avancement (totaux des votes,
  // jamais qui a voté quoi), les signalements, les notes et l'historique au journal. Actions : trancher,
  // masquer une note, masquer / rétablir / retirer pour motif légal, gel légal (clé physique + motif
  // à chaque fois, inscrites au journal) ; classer les signalements.
  import Manque from '#lib/composants/Manque.svelte';
  import { surveiller } from '#lib/surveiller.ts';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { post } from '#lib/api.ts';
  import { annulerVersion, modifierOrigine, supprimerEchec, DECIDABLES, tonStatut, relierEvenement, retirerEvenement, STATUTS_VIDEO as LIBELLES_STATUT, demasquerNote, lienVideoAdmin, masquerNote, moderer, noterTransmission, originalChiffre, etatRefloutage, refluter, STATUTS_VIDEO, trancher, videoAdmin,
           type ActionModeration, type Destinataire, type FicheAdmin } from '#lib/admin.ts';
  import SignalementAdmin from '#lib/composants/SignalementAdmin.svelte';
  import ContexteVideo from '#lib/composants/ContexteVideo.svelte';
  import DescriptionAdmin from './DescriptionAdmin.svelte';
  import LecteurVideo from '#lib/composants/LecteurVideo.svelte';
  import RetoucheFloutage, { type Zone } from '#lib/composants/RetoucheFloutage.svelte';
  import NoteAnalyste from '#lib/composants/NoteAnalyste.svelte';
  import { message } from '#lib/erreurs.ts';
  import { resume } from '#lib/journal.ts';
  import { sessionExpiree } from '#lib/porte-admin.svelte.ts';

  let { id }: { id: string } = $props();

  let v = $state<FicheAdmin | null>(null);
  let erreur = $state('');
  let info = $state('');
  let enCours = $state(false);
  let decision = $state<'publier' | 'rejeter' | 'debat' | 'relecture'>('publier');
  let motif = $state('');
  let noteAMasquer = $state<string | null>(null);
  let motifNote = $state('');

  const quand = (iso: string | null) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const pourcent = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)} %`);
  const TOURS = { review: 'Relecture', jury: 'Jury' } as const;
  const PAR = { review: 'la relecture', jury: 'le jury', legal: 'l’administration' } as const;

  // Modération : l'action choisie, son motif public, puis la clé.
  const MODERATION: Record<ActionModeration, { titre: string; aide: string; danger?: boolean }> = {
    masquer: { titre: 'Masquer', aide: 'La vidéo sort de la carte ; sa fiche affiche « en cours d’examen ». Réversible.' },
    retablir: { titre: 'Rétablir', aide: 'La vidéo retrouve son statut d’avant le masquage.' },
    retirer: { titre: 'Retirer pour motif légal', aide: 'Définitif : la version floutée est effacée, la fiche affiche « retirée pour motif légal ». L’original chiffré est gardé.', danger: true },
    geler: { titre: 'Poser un gel légal', aide: 'La source ne peut plus retirer sa vidéo (procédure en cours, réquisition).' },
    degeler: { titre: 'Lever le gel légal', aide: 'La source peut de nouveau retirer sa vidéo.' },
  };
  let moderation = $state<ActionModeration | null>(null);
  let motifModeration = $state('');
  let confirmeRetrait = $state(false);
  const actionsPossibles = $derived<ActionModeration[]>(v ? [
    ...(['published', 'under_debate'].includes(v.statut) ? ['masquer' as const] : []),
    ...(v.statut === 'hidden' ? ['retablir' as const] : []),
    ...(!['removed', 'withdrawn', 'uploading'].includes(v.statut) ? ['retirer' as const] : []),
    v.gelLegal ? 'degeler' as const : 'geler' as const,
  ] : []);
  async function moderer_() {
    const a = moderation!;
    if (await action(() => moderer(id, a, motifModeration.trim()), `${MODERATION[a].titre} : fait.`)) {
      moderation = null; motifModeration = ''; confirmeRetrait = false;
    }
  }

  let ficheEvenement = $state('');
  let motifEvenement = $state('');
  async function relier() {
    if (await action(() => relierEvenement(id, ficheEvenement.trim(), motifEvenement.trim()), 'Vidéos reliées.')) { ficheEvenement = ''; motifEvenement = ''; }
  }
  async function retirer() {
    if (await action(() => retirerEvenement(id, motifEvenement.trim()), 'Vidéo retirée de l’événement.')) motifEvenement = '';
  }
  let motifSuppression = $state('');
  let confirmeSuppression = $state(false);
  async function supprimer() {
    if (await action(() => supprimerEchec(id, motifSuppression.trim()), 'Vidéo supprimée.')) await goto('/admin/videos');
  }
  let origineOuverte = $state(false);
  let origine = $state({ publiePar: '', lien: '', precisions: '', publique: false, motif: '' });
  const lienOrigineValable = $derived(!origine.lien.trim() || /^https:\/\/\S+$/.test(origine.lien.trim()));
  function ouvrirOrigine() {
    origine = { publiePar: v?.origine?.publiePar ?? '', lien: v?.origine?.lien ?? '', precisions: v?.origine?.precisions ?? '', publique: v?.origine?.publique ?? false, motif: '' };
    origineOuverte = true;
  }
  async function enregistrerOrigine() {
    const { publiePar, lien, precisions, publique, motif } = origine;
    const saisie = { ...(publiePar.trim() ? { publiePar: publiePar.trim() } : {}), ...(lien.trim() ? { lien: lien.trim() } : {}),
                     ...(precisions.trim() ? { precisions: precisions.trim() } : {}), publique: publique && !!publiePar.trim() };
    if (await action(() => modifierOrigine(id, saisie, motif.trim()), 'Origine enregistrée.')) origineOuverte = false;
  }
  let motifVersion = $state('');
  async function annulerVersion_() {
    if (await action(() => annulerVersion(id, motifVersion.trim()), 'Rattachement annulé.')) motifVersion = '';
  }

  async function charger() {
    try {
      v = await videoAdmin(id);
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
    }
  }

  async function action(f: () => Promise<unknown>, ok: string) {
    erreur = ''; info = ''; enCours = true;
    try {
      await f();
      info = ok;
      await charger();
      return true;
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
      return false;
    } finally {
      enCours = false;
    }
  }

  async function valider() {
    const FAIT = { publier: 'Vidéo publiée.', rejeter: 'Vidéo rejetée.', debat: 'Vidéo mise en débat.', relecture: 'Relecture relancée.' };
    if (await action(() => trancher(id, decision, motif.trim()), FAIT[decision])) motif = '';
  }
  // Re-floutage : zones ajoutées (outil de retouche, sans pistes à retirer), puis motif et clé.
  let reflouter = $state(false);
  let zonesReflou = $state<Zone[] | null>(null);
  let motifReflou = $state('');
  // Pendant le re-floutage : avancement relu toutes les 4 s (sans recharger la fiche ni couper la vidéo).
  $effect(() => {
    if (!v?.refloutage?.enCours) return;
    return surveiller(async () => {
      const e = await etatRefloutage(id);
      if (v) v.refloutage = e;
      if (!e.enCours) { info = e.derniere?.echec ? '' : 'Floutage complété : la nouvelle version est en place.'; await charger(); }
    }, 4000);
  });

  async function envoyerReflou() {
    if (await action(() => refluter(id, zonesReflou!, motifReflou.trim()), 'Re-floutage lancé : la nouvelle version remplacera l’actuelle.')) {
      reflouter = false; zonesReflou = null; motifReflou = '';
    }
  }

  async function ecrireSource() {
    try {
      const r = await post<{ conversation: string }>(`/admin/videos/${id}/messagerie`);
      await goto(`/admin/messagerie/${r.conversation}`);
    } catch (x) { erreur = message(x); }
  }

  async function demasquer(note: string) {
    if (await action(() => demasquerNote(note, motifNote.trim()), 'Note démasquée.')) { noteAMasquer = null; motifNote = ''; }
  }
  async function masquer(note: string) {
    if (await action(() => masquerNote(note, motifNote.trim()), 'Note masquée.')) { noteAMasquer = null; motifNote = ''; }
  }

  // Transmission de l'original : télécharger le chiffré + l'enveloppe, l'ouvrir sur le PC, puis la noter.
  const DESTINATAIRES: Record<string, string> = { association: 'une association', lawyer: 'un avocat', journalist: 'un journaliste', other: 'autre' };
  let destinataire = $state<Destinataire>('association');
  let motifTransmission = $state('');
  let commande = $state('');
  let motifTelechargement = $state('');
  async function telechargerOriginal() {
    erreur = ''; info = '';
    try {
      const r = await originalChiffre(id, motifTelechargement.trim());
      motifTelechargement = '';
      const enveloppe = new Blob([JSON.stringify({ video: id, sha256Original: r.sha256Original, enveloppe: r.enveloppe }, null, 2)],
                                 { type: 'application/json' });
      const lienEnveloppe = URL.createObjectURL(enveloppe);
      Object.assign(document.createElement('a'), { href: lienEnveloppe, download: `enveloppe-${id}.json` }).click();
      URL.revokeObjectURL(lienEnveloppe);
      Object.assign(document.createElement('a'), { href: `/api${r.lien}`, download: `original-${id}.argos` }).click();
      commande = `python3 deploiement/admin/ouvrir-original.py ~/Téléchargements/original-${id}.argos ~/Téléchargements/enveloppe-${id}.json original-${id}.mp4`;
      info = 'Téléchargés : l’original chiffré et son enveloppe. Ouvrez-les sur votre PC avec la YubiKey (commande ci-dessous).';
    } catch (x) { if (!sessionExpiree(x)) erreur = message(x); }
  }
  async function transmettre() {
    if (await action(() => noterTransmission(id, destinataire, motifTransmission.trim()), 'Transmission notée au journal ; la source est prévenue.')) {
      motifTransmission = '';
    }
  }

  onMount(charger);
</script>

{#if v}
  <span class="surtitre">Fiche d’administration</span>
  <h1>{v.pseudonyme ?? 'Vidéo'} <span class="pastille {tonStatut(v.statut)}">{STATUTS_VIDEO[v.statut] ?? v.statut}</span>
    {#if v.gelLegal}<span class="pastille accent">Gel légal</span>{/if}</h1>
  {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}
  {#if info}<div class="message succes" role="status">{info}</div>{/if}

  <div class="grille">
    <div class="colonne">
      {#if !['processing', 'failed', 'withdrawn', 'removed'].includes(v.statut)}
        <LecteurVideo obtenirLien={() => lienVideoAdmin(id)} />
      {:else}
        <div class="carte"><p class="second">Pas de version floutée à lire ({STATUTS_VIDEO[v.statut]?.toLowerCase()}).</p></div>
      {/if}
      {#if ['in_review', 'jury', 'published', 'under_debate'].includes(v.statut)}
        <section class="carte">
          <h2>Compléter le floutage</h2>
          {#if v.refloutage?.enCours}
            {@const e = v.refloutage}
            <p class="second petit">{e.etape === 'preparation' ? 'Préparation de la version actuelle…'
              : e.etape === 'attente' ? 'En attente du worker…' : `Réencodage : ${e.avancement ?? 0} %`}</p>
            <div class="progression en-cours" role="progressbar" aria-valuenow={e.avancement ?? 0} aria-valuemin="0" aria-valuemax="100">
              <span style:width="{e.etape === 'rendu' ? (e.avancement ?? 0) : 0}%"></span>
            </div>
          {:else if !reflouter}
            {#if v.refloutage?.derniere?.echec}<p class="petit erreur-texte">Le dernier re-floutage a échoué.</p>{/if}
            <button class="bouton" onclick={() => (reflouter = true)}>Ajouter des flous…</button>
          {:else if !zonesReflou}
            <RetoucheFloutage obtenirLien={() => lienVideoAdmin(id)} pistes={[]} retouche={{ retirees: [], zones: [] }}
                              retouchesRestantes={1} libelle="Continuer" appliquer={async (_r, z) => { zonesReflou = z; }} />
            <button class="bouton lien" onclick={() => (reflouter = false)}>Annuler</button>
          {:else}
            <p class="second petit">{zonesReflou.length} zone{zonesReflou.length > 1 ? 's' : ''} à ajouter.</p>
            <div class="champ">
              <label for="motif-reflou">Motif</label>
              <textarea id="motif-reflou" placeholder="Public : aucun nom ni détail identifiant" rows="2" maxlength="2000" bind:value={motifReflou}></textarea>
            </div>
            <div class="boutons">
              <Manque raisons={[motifReflou.trim().length < 10 && 'motif (10 car.)']}><button class="bouton principal" disabled={enCours || motifReflou.trim().length < 10} onclick={envoyerReflou}>
                {enCours ? 'Touchez votre clé…' : 'Re-flouter'}</button></Manque>
              <button class="bouton" onclick={() => { zonesReflou = null; }}>Retour</button>
            </div>
          {/if}
        </section>
      {/if}

      <div class="carte"><ContexteVideo c={v} />
        {#if !['uploading', 'withdrawn', 'removed', 'failed'].includes(v.statut)}
          <p class="petit"><a href="/analyste/{id}">Corriger la date, l’heure ou le lieu, ou ajouter une note (outils d’analyste)</a></p>
        {/if}
      </div>
      {#if !['uploading', 'withdrawn', 'removed'].includes(v.statut)}
        <DescriptionAdmin video={id} actuelle={v.description} apres={charger} />
      {/if}

      <section class="carte">
        <h2>Signalements</h2>
        {#each v.signalements as sg (sg.id)}
          <SignalementAdmin s={sg} apres={charger} />
        {:else}
          <p class="second petit">Aucun signalement.</p>
        {/each}
      </section>

      <section>
        <h2>Notes des analystes</h2>
        {#if v.notesMasquees}<p class="petit discret">{v.notesMasquees} note{v.notesMasquees > 1 ? 's' : ''} masquée{v.notesMasquees > 1 ? 's' : ''}.</p>{/if}
        {#each v.notes as n (n.note)}
          <div class:masquee={!!n.masquee}>
          {#if n.masquee}
            <div class="message attention petit">Masquée le {new Date(n.masquee.le).toLocaleDateString('fr-FR')} — motif : {n.masquee.motif}</div>
          {/if}
          <NoteAnalyste note={n}>
            {#snippet actions()}
              {#if noteAMasquer === n.note}
                <div class="champ">
                  <label for="motif-note">{n.masquee ? 'Motif du démasquage (public)' : 'Motif du masquage (public)'}</label>
                  <textarea id="motif-note" placeholder="Public : aucun nom ni détail identifiant" rows="2" maxlength="2000" bind:value={motifNote}></textarea>
                </div>
                <div class="boutons">
                  <Manque raisons={[motifNote.trim().length < 10 && 'motif (10 car.)']}><button class="bouton principal" disabled={enCours || motifNote.trim().length < 10}
                          onclick={() => (n.masquee ? demasquer(n.note) : masquer(n.note))}>
                    {enCours ? 'Touchez votre clé…' : n.masquee ? 'Démasquer' : 'Masquer'}</button></Manque>
                  <button class="bouton" onclick={() => (noteAMasquer = null)}>Annuler</button>
                </div>
              {:else}
                <button class="bouton" onclick={() => { noteAMasquer = n.note; motifNote = ''; }}>
                  {n.masquee ? 'Démasquer cette note' : 'Masquer cette note'}</button>
              {/if}
            {/snippet}
          </NoteAnalyste>
          </div>
        {:else}
          <p class="second petit">Aucune note.</p>
        {/each}
      </section>
    </div>

    <aside class="colonne">
      {#if DECIDABLES.includes(v.statut)}
        <section class="carte">
          <h2>Trancher</h2>
          <p class="petit">État actuel : <span class="pastille {tonStatut(v.statut)}">{LIBELLES_STATUT[v.statut] ?? v.statut}</span></p>
          <div class="choix">
            <label class="case"><input type="radio" bind:group={decision} value="publier" /> Publier</label>
            <label class="case"><input type="radio" bind:group={decision} value="rejeter" /> Rejeter</label>
            {#if v.statut !== 'under_debate'}
              <label class="case"><input type="radio" bind:group={decision} value="debat" /> Mettre en débat</label>
            {/if}
            {#if ['published', 'rejected', 'under_debate', 'no_decision'].includes(v.statut)}
              <label class="case"><input type="radio" bind:group={decision} value="relecture" /> Relancer la relecture</label>
            {/if}
          </div>
          <div class="champ">
            <label for="motif">Motif (public)</label>
            <textarea id="motif" placeholder="Public : aucun nom ni détail identifiant" rows="3" maxlength="2000" bind:value={motif}></textarea>
          </div>
          <Manque raisons={[motif.trim().length < 10 && 'motif (10 car.)']}><button class="bouton principal" disabled={enCours || motif.trim().length < 10} onclick={valider}>
            {enCours ? 'Touchez votre clé…' : 'Confirmer'}</button></Manque>
        </section>
      {/if}

      <section class="carte">
        <h2>Avancement</h2>
        <dl>
          <dt>Envoyée</dt><dd>{quand(v.envoyeeLe)}</dd>
          {#if v.relectureDepuis}<dt>En relecture depuis</dt><dd>{quand(v.relectureDepuis)}</dd>{/if}
          {#if v.juryDepuis}<dt>Devant le jury depuis</dt><dd>{quand(v.juryDepuis)}</dd>{/if}
          {#if v.decideeLe}<dt>Décidée</dt><dd>{quand(v.decideeLe)}{v.decideePar ? ` par ${PAR[v.decideePar]}` : ''}</dd>{/if}
          {#if v.retireeLe}<dt>Retirée par la source</dt><dd>{quand(v.retireeLe)}</dd>{/if}
          <dt>Élargissements</dt><dd>{v.elargissements}</dd>
          {#if v.premierTour !== null}<dt>Oui au 1er tour</dt><dd>{pourcent(v.premierTour)}</dd>{/if}
          {#if v.duree}<dt>Durée</dt><dd>{Math.round(v.duree)} s</dd>{/if}
          {#if v.retouches}<dt>Retouches du floutage</dt><dd>{v.retouches}</dd>{/if}
          {#if v.echec}<dt>Échec</dt><dd class="rouge">{v.echec}</dd>{/if}
        </dl>
        {#each Object.entries(TOURS) as [tour, nom] (tour)}
          {@const t = v.votes[tour as 'review' | 'jury']}
          {@const c = v.convocations[tour as 'review' | 'jury']}
          {#if t || c}
            <h3>{nom}</h3>
            <dl>
              {#if c}<dt>Convocations</dt><dd>{c.envoyees} · {c.repondues} réponses · {c.enAttente} en attente · {c.expirees} expirées</dd>{/if}
              {#if t}
                <dt>Votes</dt><dd>{t.oui} oui · {t.enPartie} en partie · {t.non} non</dd>
                <dt>Part de oui (pondérée)</dt><dd>{pourcent(t.partOui)} <span class="discret">(poids {t.poids})</span></dd>
                {#if t.visageSignale}<dt>Visage signalé</dt><dd class="rouge">{t.visageSignale} fois</dd>{/if}
              {/if}
            </dl>
          {/if}
        {/each}
      </section>

      {#if v.statut === 'failed' && !v.gelLegal}
        <section class="carte">
          <h2>Supprimer</h2>
          <div class="champ">
            <label for="motif-suppression">Motif (public, inscrit au journal)</label>
            <textarea id="motif-suppression" placeholder="Public : aucun nom ni détail identifiant" rows="2" maxlength="2000" bind:value={motifSuppression}></textarea>
          </div>
          <label class="case petit"><input type="checkbox" bind:checked={confirmeSuppression} /> Je confirme : la suppression est définitive, original compris.</label>
          <Manque raisons={[!confirmeSuppression && 'case de confirmation', motifSuppression.trim().length < 10 && 'motif (10 car.)']}><button class="bouton danger" onclick={supprimer} disabled={enCours || !confirmeSuppression || motifSuppression.trim().length < 10}>
            {enCours ? 'Touchez votre clé…' : 'Supprimer la vidéo'}</button></Manque>
        </section>
      {/if}

      {#if !['uploading', 'withdrawn'].includes(v.statut)}
        <section class="carte">
          <h2>Origine</h2>
          {#if !origineOuverte}
            {#if v.origine}
              <dl class="petit">
                {#if v.origine.publiePar}<dt>Publiée par</dt><dd>{v.origine.publiePar}</dd>{/if}
                {#if v.origine.lien}<dt>Lien</dt><dd class="lien-origine"><a href={v.origine.lien} target="_blank" rel="noopener noreferrer nofollow ugc">{v.origine.lien} ↗</a></dd>{/if}
                {#if v.origine.precisions}<dt>Précisions</dt><dd class="precisions-origine">{v.origine.precisions}</dd>{/if}
              </dl>
            {/if}
            <p class="petit second">{#if v.origine}{v.origine.publique ? 'Citée sur la fiche publique' : 'Non publique'}{:else}Aucune origine indiquée{/if}</p>
            <button class="bouton" onclick={ouvrirOrigine}>Modifier</button>
          {:else}
            <div class="champ"><label for="or-nom">Publiée par</label><input id="or-nom" maxlength="200" bind:value={origine.publiePar} /></div>
            <div class="champ"><label for="or-lien">Lien</label><input id="or-lien" type="url" maxlength="500" bind:value={origine.lien} aria-invalid={!lienOrigineValable || undefined} /></div>
            <div class="champ"><label for="or-precisions">Précisions</label><textarea id="or-precisions" rows="2" maxlength="2000" bind:value={origine.precisions}></textarea></div>
            <label class="case petit"><input type="checkbox" bind:checked={origine.publique} disabled={!origine.publiePar.trim()} /> Citer sur la fiche publique</label>
            <div class="champ"><label for="or-motif">Motif (public, inscrit au journal)</label><textarea id="or-motif" placeholder="Public : aucun nom ni détail identifiant" rows="2" maxlength="2000" bind:value={origine.motif}></textarea></div>
            <div class="boutons">
              <Manque raisons={[!lienOrigineValable && 'lien https valable', origine.motif.trim().length < 10 && 'motif (10 car.)']}><button class="bouton principal" onclick={enregistrerOrigine} disabled={enCours || !lienOrigineValable || origine.motif.trim().length < 10}>{enCours ? 'Touchez votre clé…' : 'Enregistrer'}</button></Manque>
              <button class="bouton lien" onclick={() => (origineOuverte = false)}>Annuler</button>
            </div>
          {/if}
        </section>
      {/if}

      <section class="carte">
        <h2>Modération</h2>
        <div class="boutons serre">
          {#each actionsPossibles as a (a)}
            <button class="bouton {MODERATION[a].danger ? 'danger' : ''}" aria-pressed={moderation === a}
                    onclick={() => { moderation = moderation === a ? null : a; motifModeration = ''; confirmeRetrait = false; }}>
              {MODERATION[a].titre}</button>
          {/each}
        </div>
        {#if moderation}
          <div class="champ">
            <label for="motif-moderation">Motif (public, inscrit au journal)</label>
            <textarea id="motif-moderation" placeholder="Public : aucun nom ni détail identifiant" rows="3" maxlength="2000" bind:value={motifModeration}></textarea>
          </div>
          {#if moderation === 'retirer'}
            <label class="case petit"><input type="checkbox" bind:checked={confirmeRetrait} /> Je confirme : ce retrait est définitif.</label>
          {/if}
          <Manque raisons={[motifModeration.trim().length < 10 && 'motif (10 car.)', moderation === 'retirer' && !confirmeRetrait && 'case de confirmation']}><button class="bouton principal" onclick={moderer_}
                  disabled={enCours || motifModeration.trim().length < 10 || (moderation === 'retirer' && !confirmeRetrait)}>
            {enCours ? 'Touchez votre clé…' : 'Confirmer'}</button></Manque>
        {/if}
      </section>

      {#if v.versionDe}
        <section class="carte">
          <h2>Version</h2>
          <p class="petit">De <a href="/admin/videos/{v.versionDe.id}">{v.versionDe.pseudonyme ?? 'la fiche d’origine'}</a></p>
          <div class="champ">
            <label for="motif-version">Motif (public, inscrit au journal)</label>
            <textarea id="motif-version" placeholder="Public : aucun nom ni détail identifiant" rows="2" maxlength="2000" bind:value={motifVersion}></textarea>
          </div>
          <Manque raisons={[motifVersion.trim().length < 10 && 'motif (10 car.)']}><button class="bouton" onclick={annulerVersion_} disabled={enCours || motifVersion.trim().length < 10}>
            {enCours ? 'Touchez votre clé…' : 'Annuler le rattachement'}</button></Manque>
        </section>
      {/if}

      <section class="carte">
        <h2>Même événement</h2>
        {#if v.memeEvenement.length}
          <ul class="petit">{#each v.memeEvenement as x (x.id)}<li><a href="/admin/videos/{x.id}">{x.pseudonyme ?? 'Vidéo'}</a>
            <span class="discret">({LIBELLES_STATUT[x.statut] ?? x.statut})</span></li>{/each}</ul>
        {/if}
        <div class="champ">
          <label for="fiche-evenement">Nom ou lien d’une fiche publiée</label>
          <input id="fiche-evenement" type="text" maxlength="300" bind:value={ficheEvenement} />
        </div>
        <div class="champ">
          <label for="motif-evenement">Motif (public, inscrit au journal)</label>
          <textarea id="motif-evenement" placeholder="Public : aucun nom ni détail identifiant" rows="2" maxlength="2000" bind:value={motifEvenement}></textarea>
        </div>
        <div class="boutons serre">
          <Manque raisons={[!ficheEvenement.trim() && 'fiche', motifEvenement.trim().length < 10 && 'motif (10 car.)']}><button class="bouton" onclick={relier} disabled={enCours || !ficheEvenement.trim() || motifEvenement.trim().length < 10}>Relier</button></Manque>
          {#if v.memeEvenement.length}
            <Manque raisons={[motifEvenement.trim().length < 10 && 'motif (10 car.)']}><button class="bouton" onclick={retirer} disabled={enCours || motifEvenement.trim().length < 10}>Retirer de l’événement</button></Manque>
          {/if}
        </div>
      </section>

      <section class="carte">
        <h2>Source</h2>
        <button class="bouton" disabled={enCours} onclick={ecrireSource}>Écrire à la source</button>
      </section>

      <section class="carte">
        <h2>Original</h2>
        {#if v.transmission.autorisee}
          <p class="petit second">La source autorise la transmission de l’original non flouté{#if v.transmission.autoriseeLe}
            (depuis le {quand(v.transmission.autoriseeLe)}){/if}. Il ne s’ouvre que sur votre PC, avec la YubiKey.</p>
          <div class="champ">
            <label for="motif-telechargement">Motif du téléchargement (public, inscrit au journal ; la source est prévenue)</label>
            <textarea id="motif-telechargement" placeholder="Public : aucun nom ni détail identifiant" rows="2" maxlength="2000" bind:value={motifTelechargement}></textarea>
          </div>
          <Manque raisons={[motifTelechargement.trim().length < 10 && 'motif (10 car.)']}><button class="bouton" onclick={telechargerOriginal} disabled={motifTelechargement.trim().length < 10}>Télécharger l’original chiffré et son enveloppe</button></Manque>
          {#if commande}<p class="petit">Puis, dans un terminal :</p><code class="commande">{commande}</code>{/if}
          <h3>Noter une transmission</h3>
          <div class="champ">
            <label for="destinataire">Destinataire (public : le type seulement, jamais le nom)</label>
            <select id="destinataire" bind:value={destinataire}>
              <option value="association">Une association</option><option value="avocat">Un avocat</option>
              <option value="journaliste">Un journaliste</option><option value="autre">Autre</option>
            </select>
          </div>
          <div class="champ">
            <label for="motif-transmission">Motif (public, inscrit au journal)</label>
            <textarea id="motif-transmission" placeholder="Public : aucun nom ni détail identifiant" rows="3" maxlength="2000" bind:value={motifTransmission}></textarea>
          </div>
          <Manque raisons={[motifTransmission.trim().length < 10 && 'motif (10 car.)']}><button class="bouton principal" disabled={enCours || motifTransmission.trim().length < 10} onclick={transmettre}>
            {enCours ? 'Touchez votre clé…' : 'Confirmer'}</button></Manque>
        {:else}
          <p class="petit second">Transmission non autorisée par la source.</p>
        {/if}
        {#if v.transmission.transmissions.length}
          <ul class="petit">{#each v.transmission.transmissions as t (t.le)}<li>Transmis le {quand(t.le)} à {DESTINATAIRES[t.destinataire]}</li>{/each}</ul>
        {/if}
      </section>

      <section class="carte">
        <h2>Journal</h2>
        {#each v.journal as e (e.numero)}
          <div class="petit entree"><span class="discret">n° {e.numero} · {quand(e.le)}</span><br />
            {resume({ ...e, empreinte: '', precedente: '' })}</div>
        {:else}
          <p class="petit second">Aucune entrée.</p>
        {/each}
      </section>
    </aside>
  </div>
{:else if erreur}
  <div class="message erreur">{erreur}</div>
{/if}

<style>
  .erreur-texte { color: var(--danger); }
  .masquee { opacity: 0.7; }
  .masquee .message { margin-bottom: 0.5rem; }
  h1 .pastille { vertical-align: middle; font-size: 0.875rem; }
  .grille { display: grid; grid-template-columns: minmax(0, 1fr) 24rem; gap: 1.5rem; align-items: start; margin-top: 1.5rem; }
  @media (max-width: 60rem) { .grille { grid-template-columns: 1fr; } }
  .colonne { display: grid; gap: 1rem; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 0.75rem; margin: 0 0 0.75rem; font-size: 0.9375rem; }
  dt { color: var(--texte-2); }
  dd { margin: 0; text-align: right; }
  h3 { margin: 1rem 0 0.5rem; font-size: 1rem; }
  .rouge { color: var(--danger); }
  .serre { margin-top: 0; }
  [aria-pressed='true'] { border-color: var(--accent); background: var(--accent-doux); }
  .bouton.danger { color: var(--danger); border-color: var(--danger); }
  .choix { display: flex; gap: 1.5rem; margin: 0.75rem 0; }
  .entree { padding: 0.375rem 0; border-bottom: 1px solid var(--trait); }
  .commande { display: block; padding: 0.5rem; background: var(--surface-2); border-radius: var(--rayon); font-size: 0.75rem; word-break: break-all; user-select: all; }
  .lien-origine, .precisions-origine { overflow-wrap: anywhere; }
  .precisions-origine { white-space: pre-line; }
</style>
