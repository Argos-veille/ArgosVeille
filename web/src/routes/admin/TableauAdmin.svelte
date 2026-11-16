<script lang="ts">
  import Manque from '#lib/composants/Manque.svelte';
  import NotesAdmin from './NotesAdmin.svelte';
  import ServeurAdmin from './ServeurAdmin.svelte';
  // Contenu de l'administration (session ouverte) : ce qui demande attention, chiffres, alertes, bugs.
  import { onMount } from 'svelte';
  import { alertes, rapportsBug, STATUTS_BUG, tableauDeBord, themesBug, trancher, type AlerteJury, type RapportBug,
           type StatutBug, type TableauDeBord, type ThemeBug } from '#lib/admin.ts';
  import { message } from '#lib/erreurs.ts';
  import { CATEGORIES, SOUS_CATEGORIES } from '#lib/libelles.ts';
  import { sessionExpiree } from '#lib/porte-admin.svelte.ts';

  let t = $state<TableauDeBord | null>(null);
  let jures = $state<AlerteJury[]>([]);
  let bugs = $state<RapportBug[]>([]);
  let themes = $state<ThemeBug[]>([]);
  let statut = $state<StatutBug>('open');
  let erreur = $state('');

  // Trancher une vidéo sans jurés : décision, motif, puis la clé physique.
  let ouverte = $state<string | null>(null);
  let decision = $state<'publier' | 'rejeter'>('publier');
  let motif = $state('');
  let enCours = $state(false);
  let erreurDecision = $state('');
  let fait = $state('');

  // Sections du tableau de bord : repliables et réordonnables, choix gardés dans ce navigateur.
  const TITRES: Record<string, string> = {
    notes: 'Notes', 'a-traiter': 'À traiter', videos: 'Vidéos', relecture: 'Relecture', envois: 'Envois', communaute: 'Communauté',
    sante: 'Santé du site', serveur: 'Serveur', jures: 'Vidéos sans jurés', bugs: 'Rapports de bug',
  };
  const ANCRES: Record<string, string> = { jures: 'alertes' };
  const CLE_DISPOSITION = 'argos-admin-tableau';
  let ordre = $state(Object.keys(TITRES));
  let fermees = $state<string[]>([]);
  function lireDisposition() {
    try {
      const d = JSON.parse(localStorage.getItem(CLE_DISPOSITION) ?? '{}') as { ordre?: string[]; fermees?: string[] };
      const connus = (d.ordre ?? []).filter((x) => x in TITRES);
      const nouvelles = Object.keys(TITRES).filter((x) => !connus.includes(x));
      // Une nouvelle section va à la fin, sauf les notes, en tête.
      ordre = [...nouvelles.filter((x) => x === 'notes'), ...connus, ...nouvelles.filter((x) => x !== 'notes')];
      fermees = (d.fermees ?? []).filter((x) => x in TITRES);
    } catch { /* stockage indisponible : disposition par défaut */ }
  }
  function garderDisposition() {
    try { localStorage.setItem(CLE_DISPOSITION, JSON.stringify({ ordre, fermees })); } catch { /* sans effet */ }
  }
  function basculer(id: string) {
    fermees = fermees.includes(id) ? fermees.filter((x) => x !== id) : [...fermees, id];
    garderDisposition();
  }
  function ouvrir(id: string) {
    if (fermees.includes(id)) basculer(id);
  }
  function deplacer(i: number, sens: -1 | 1) {
    const o = [...ordre];
    [o[i], o[i + sens]] = [o[i + sens]!, o[i]!];
    ordre = o;
    garderDisposition();
  }
  const taux = (n: number, total: number) => (total ? `${Math.round((n / total) * 100)} %` : '—');
  function duree(minutes: number | null) {
    if (minutes === null) return '—';
    if (minutes < 60) return `${Math.round(minutes)} min`;
    if (minutes < 48 * 60) return `${Math.round(minutes / 6) / 10} h`;
    return `${Math.round(minutes / 144) / 10} j`;
  }
  function reste(fin: string) {
    const j = (new Date(fin).getTime() - Date.now()) / 86_400_000;
    return j <= 0 ? 'délai dépassé' : `reste ${j < 1 ? 'moins d’un jour' : `${Math.floor(j)} j`}`;
  }

  const quand = (iso: string | null) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const libelleTheme = (cle: string) => themes.find((x) => x.cle === cle)?.libelle ?? cle;
  const libellePrecis = (theme: string, cle: string) =>
    themes.find((x) => x.cle === theme)?.precis.find((p) => p.cle === cle)?.libelle ?? cle;

  async function charger() {
    erreur = '';
    try {
      [t, jures, bugs] = await Promise.all([tableauDeBord(), alertes().then((a) => a.juresManquants),
                                            rapportsBug(statut).then((b) => b.rapports)]);
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
    }
  }

  async function changerStatut(s: StatutBug) {
    statut = s;
    try {
      bugs = (await rapportsBug(s)).rapports;
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
    }
  }

  async function valider(video: string) {
    erreurDecision = '';
    enCours = true;
    try {
      const r = await trancher(video, decision, motif.trim());
      fait = { publiee: 'Vidéo publiée.', en_attente_analyse: 'Vidéo en attente d’analyse (lieu ou date à établir).' }[r.statut] ?? 'Vidéo rejetée.';
      ouverte = null;
      motif = '';
      await charger();
    } catch (x) {
      if (!sessionExpiree(x)) erreurDecision = message(x);
    } finally {
      enCours = false;
    }
  }

  onMount(() => {
    lireDisposition();
    charger();
    themesBug().then((r) => (themes = r.themes)).catch(() => {});
  });
  const NOMS_STATUT: Record<string, string> = { journalist: 'journaliste', lawyer: 'avocat', association: 'association', osint_analyst: 'analyste' };
</script>

{#if erreur}<div class="message erreur">{erreur}</div>{/if}

{#if t}
  {#snippet contenu(id: string, t: TableauDeBord)}
    {#if id === 'notes'}
      <NotesAdmin />
    {:else if id === 'serveur'}
      <ServeurAdmin />
    {:else if id === 'a-traiter'}
    <div class="tuiles">
      <a class="tuile {t.aTraiter.juresManquants ? 'alerte' : ''}" href="#alertes" onclick={() => ouvrir('jures')}>
        <span class="nombre">{t.aTraiter.juresManquants}</span><span>vidéo{t.aTraiter.juresManquants > 1 ? 's' : ''} sans jurés</span>
      </a>
      <a class="tuile {t.aTraiter.signalementsGraves ? 'alerte' : ''}" href="/admin/signalements">
        <span class="nombre">{t.aTraiter.signalements}</span>
        <span>signalement{t.aTraiter.signalements > 1 ? 's' : ''}{#if t.aTraiter.signalementsGraves}, dont {t.aTraiter.signalementsGraves} grave{t.aTraiter.signalementsGraves > 1 ? 's' : ''}{/if}</span>
      </a>
      <a class="tuile {t.recours.sansDecision ? 'alerte' : ''}" href="/admin/videos?statut=no_decision">
        <span class="nombre">{t.recours.sansDecision}</span>
        <span>vidéo{t.recours.sansDecision > 1 ? 's' : ''} sans décision, à trancher{#if t.recours.plusAncienne} (depuis le {quand(t.recours.plusAncienne)}){/if}</span>
      </a>
      <a class="tuile" href="/admin/videos?statut=awaiting_osint">
        <span class="nombre">{t.analyse.enAttente}</span>
        <span>vidéo{t.analyse.enAttente > 1 ? 's' : ''} en attente d’analyse{#if t.analyse.plusAncienne} (depuis le {quand(t.analyse.plusAncienne)}){/if}</span>
      </a>
      <div class="tuile {t.statutsARenouveler.nombre ? 'alerte' : ''}">
        <span class="nombre">{t.statutsARenouveler.nombre}</span>
        <span>statut{t.statutsARenouveler.nombre > 1 ? 's' : ''} à renouveler (30 j)
          {#each t.statutsARenouveler.prochains as x (x.compte + x.statut)}<br /><a href="/admin/comptes/{x.compte}">{x.pseudo}</a> · {NOMS_STATUT[x.statut] ?? x.statut} · {quand(x.expire)}{/each}</span>
      </div>
      <a class="tuile" href="/admin/contact">
        <span class="nombre">{t.aTraiter.contacts ?? 0}</span>
        <span>message{(t.aTraiter.contacts ?? 0) > 1 ? 's' : ''} de contact</span>
      </a>
      <a class="tuile" href="/admin/doublons">
        <span class="nombre">{t.aTraiter.doublons ?? 0}</span>
        <span>doublon{(t.aTraiter.doublons ?? 0) > 1 ? 's' : ''} possible{(t.aTraiter.doublons ?? 0) > 1 ? 's' : ''}</span>
      </a>
      <a class="tuile" href="/admin/comptes?nonLus=true">
        <span class="nombre">{t.aTraiter.messages ?? 0}</span>
        <span>conversation{(t.aTraiter.messages ?? 0) > 1 ? 's' : ''} avec une réponse non lue</span>
      </a>
      <a class="tuile {t.aTraiter.bugsUrgents ? 'alerte' : ''}" href="#bugs" onclick={() => ouvrir('bugs')}>
        <span class="nombre">{t.aTraiter.bugs}</span>
        <span>rapport{t.aTraiter.bugs > 1 ? 's' : ''} de bug{#if t.aTraiter.bugsUrgents}, dont {t.aTraiter.bugsUrgents} urgent{t.aTraiter.bugsUrgents > 1 ? 's' : ''}{/if}</span>
      </a>
    </div>
    {:else if id === 'videos'}
      <div class="carte"><dl>
        <dt>En attente de vérification par la source</dt><dd>{t.videos.aVerifier}</dd>
        <dt>En traitement</dt><dd>{t.videos.enTraitement}{#if t.videos.enFile} (dont {t.videos.enFile} en file){/if}</dd>
        <dt>En relecture</dt><dd>{t.videos.enRelecture}</dd>
        <dt>Devant le jury</dt><dd>{t.videos.auJury}</dd>
        <dt>En attente d’analyse</dt><dd><a href="/admin/videos?statut=awaiting_osint">{t.analyse.enAttente}</a></dd>
        <dt>En débat</dt><dd>{t.videos.enDebat}</dd>
        <dt>Publiées</dt><dd>{t.videos.publiees} <span class="discret">(+{t.videos.publiees7j} en 7 jours)</span></dd>
        <dt>Échecs de traitement</dt><dd class={t.videos.echecs ? 'rouge' : ''}>{t.videos.echecs}</dd>
      </dl></div>
    {:else if id === 'relecture'}
      <div class="carte"><dl>
        <dt>Relecteurs disponibles aujourd’hui</dt><dd>{t.relecture.disponibles}</dd>
        <dt>Vivier du jury</dt><dd class={t.relecture.vivierJury < t.relecture.jurySize ? 'rouge' : ''}>{t.relecture.vivierJury} <span class="discret">(jury de {t.relecture.jurySize})</span></dd>
        <dt>Convocations (30 jours)</dt><dd>{t.relecture.convocations30j.votees} votées · {t.relecture.convocations30j.passees} passées · {t.relecture.convocations30j.expirees} expirées · {t.relecture.convocations30j.enAttente} en attente</dd>
        <dt>Taux de réponse (30 jours)</dt><dd>{taux(t.relecture.convocations30j.votees, t.relecture.convocations30j.votees + t.relecture.convocations30j.passees + t.relecture.convocations30j.expirees)}</dd>
        <dt>Durée moyenne d’une relecture (30 jours)</dt><dd>{duree(t.relecture.dureeMoyenneHeures === null ? null : t.relecture.dureeMoyenneHeures * 60)}</dd>
        <dt>Plus ancienne en relecture</dt><dd>{#if t.relecture.plusAncienne}depuis le {quand(t.relecture.plusAncienne.depuis)} <span class="discret">({reste(t.relecture.plusAncienne.fin)})</span>{:else}—{/if}</dd>
        <dt>Décisions (30 jours)</dt><dd>{t.relecture.decisions30j.publiees} publiées · {t.relecture.decisions30j.rejetees} rejetées · {t.relecture.decisions30j.enDebat} en débat · {t.relecture.decisions30j.sansDecision} sans décision · {t.analyse.arrivees30j} en attente d’analyse</dd>
      </dl></div>
    {:else if id === 'envois'}
      <div class="carte"><dl>
        <dt>Reçues (24 h)</dt><dd>{t.envois.recues24h}</dd>
        <dt>Reçues (7 jours)</dt><dd>{t.envois.recues7j} <span class="discret">(dont {t.envois.avecCompte7j} avec un compte)</span></dd>
        <dt>Échecs de traitement (7 jours)</dt><dd class={t.envois.echecs7j ? 'rouge' : ''}>{t.envois.echecs7j} <span class="discret">({taux(t.envois.echecs7j, t.envois.recues7j)})</span></dd>
        <dt>Délai moyen jusqu’à la vérification par la source</dt><dd>{duree(t.envois.traitementMoyenMinutes)}</dd>
        <dt>Doublons détectés (7 jours)</dt><dd><a href="/admin/doublons">{t.envois.doublons7j}</a></dd>
      </dl></div>
    {:else if id === 'communaute'}
      <div class="carte"><dl>
        <dt>Comptes actifs</dt><dd>{t.communaute.comptes}</dd>
        <dt>Relecteurs actifs (30 jours)</dt><dd>{t.communaute.relecteursActifs30j}</dd>
        <dt>Inscriptions (7 jours)</dt><dd>{t.communaute.inscriptions7j}</dd>
        <dt>Analystes OSINT</dt><dd>{t.communaute.analystes}</dd>
        <dt>Avec double authentification</dt><dd>{t.communaute.avecDoubleAuth}</dd>
      </dl></div>
    {:else if id === 'sante'}
      <div class="carte"><dl>
        <dt>Journal public</dt>
        <dd class={t.sante.journalIntact ? 'vert' : 'rouge'}>{t.sante.journalIntact ? 'intact' : 'ROMPU'} · {t.sante.entreesJournal} entrées</dd>
        <dt>Dernier ancrage Bitcoin</dt>
        <dd>{#if t.sante.dernierAncrage}{t.sante.dernierAncrage.jour}{t.sante.dernierAncrage.simule ? ' (simulé)' : ''}{#if t.sante.dernierAncrage.bloc} · bloc {t.sante.dernierAncrage.bloc}{/if}{:else}aucun{/if}</dd>
        <dt>Dernière convocation</dt><dd>{quand(t.sante.derniereConvocation)}</dd>
        <dt>Dernier vote</dt><dd>{quand(t.sante.dernierVote)}</dd>
        <dt>Erreurs du serveur (24 h)</dt><dd class={t.sante.erreursServeur24h ? 'rouge' : ''}><a href="/admin/erreurs">{t.sante.erreursServeur24h}</a></dd>
      </dl></div>
    {:else if id === 'jures'}
    {#if fait}<div class="message succes">{fait}</div>{/if}
    {#each jures as a (a.video)}
      <div class="carte ligne">
        <div class="entete">
          <div>
            <strong>{a.categorie ? CATEGORIES[a.categorie] : 'Nature non précisée'}{#if a.sousCategorie}{' · '}{SOUS_CATEGORIES[a.sousCategorie]}{/if}</strong>
            <div class="petit discret">En attente depuis le {quand(a.depuis)}{#if a.vivier !== null} · vivier : {a.vivier} juré{a.vivier > 1 ? 's' : ''}{/if}
              {#if a.date} · faits du {new Date(a.date).toLocaleDateString('fr-FR')}{/if}</div>
          </div>
          <div class="boutons serre">
            <a class="bouton" href="/admin/videos/{a.video}">Voir la fiche</a>
            <button class="bouton principal" onclick={() => { ouverte = ouverte === a.video ? null : a.video; erreurDecision = ''; fait = ''; }}>
              Trancher</button>
          </div>
        </div>
        {#if ouverte === a.video}
          <div class="decision">
            <div class="choix">
              <label class="case"><input type="radio" bind:group={decision} value="publier" /> Publier</label>
              <label class="case"><input type="radio" bind:group={decision} value="rejeter" /> Rejeter</label>
            </div>
            <div class="champ">
              <label for="motif-{a.video}">Motif (public)</label>
              <textarea id="motif-{a.video}" rows="3" maxlength="2000" bind:value={motif}></textarea>
            </div>
            {#if erreurDecision}<div class="message erreur">{erreurDecision}</div>{/if}
            <Manque raisons={[motif.trim().length < 10 && 'motif (10 car.)']}><button class="bouton principal" disabled={enCours || motif.trim().length < 10} onclick={() => valider(a.video)}>
              {enCours ? 'Touchez votre clé…' : 'Confirmer'}</button></Manque>
          </div>
        {/if}
      </div>
    {:else}
      <div class="carte"><p class="second">Aucune vidéo n’attend de décision.</p></div>
    {/each}
    {:else if id === 'bugs'}
    <div class="onglets" role="tablist">
      {#each Object.entries(STATUTS_BUG) as [cle, texte] (cle)}
        <button role="tab" class="bouton" aria-selected={statut === cle} onclick={() => changerStatut(cle as StatutBug)}>{texte}</button>
      {/each}
    </div>
    {#each bugs as b (b.id)}
      <a class="carte ligne lien" href="/admin/bugs/{b.id}">
        <div>
          {#if b.urgent}<span class="pastille urgent">Urgent</span>{/if}
          <strong>{libelleTheme(b.theme)}</strong> · {libellePrecis(b.theme, b.precis)}
          <div class="second extrait">{b.extrait}</div>
          <div class="petit discret">{quand(b.le)} · {b.page}{b.pageSource ? ' (page des sources)' : ''} · {b.pseudo ?? 'anonyme'}{b.capture ? ' · capture jointe' : ''}</div>
        </div>
      </a>
    {:else}
      <div class="carte"><p class="second">Aucun rapport.</p></div>
    {/each}
    {/if}
  {/snippet}

  {#each ordre as id, i (id)}
    <section id={ANCRES[id] ?? id}>
      <div class="titre-section">
        <h2><button class="replier" aria-expanded={!fermees.includes(id)} onclick={() => basculer(id)}>
          <span class="chevron" aria-hidden="true">{fermees.includes(id) ? '▸' : '▾'}</span>{TITRES[id]}</button></h2>
        <span class="deplacer">
          <button class="bouton" aria-label="Monter « {TITRES[id]} »" disabled={i === 0} onclick={() => deplacer(i, -1)}>↑</button>
          <button class="bouton" aria-label="Descendre « {TITRES[id]} »" disabled={i === ordre.length - 1} onclick={() => deplacer(i, 1)}>↓</button>
        </span>
      </div>
      {#if !fermees.includes(id)}{@render contenu(id, t)}{/if}
    </section>
  {/each}
{/if}

<style>
  section { margin-bottom: 2rem; }
  .titre-section { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 0.75rem; }
  .titre-section h2 { margin: 0; }
  .replier { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 0.5rem; }
  .replier:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
  .chevron { width: 1rem; color: var(--texte-3); }
  .deplacer { display: flex; gap: 0.25rem; }
  .deplacer .bouton { padding: 0.2rem 0.6rem; min-height: 0; }
  .carte dl { max-width: 48rem; }
  .tuiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 0.75rem; }
  .tuile { display: grid; gap: 0.25rem; padding: 1rem 1.25rem; background: var(--surface); border: 1px solid var(--trait);
           border-radius: var(--rayon-grand); color: var(--texte); text-decoration: none; }
  a.tuile:hover { border-color: var(--trait-fort); }
  .tuile.alerte { border-color: var(--danger); background: var(--danger-doux); }
  .nombre { font-size: 2rem; font-weight: 700; line-height: 1; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 0.375rem 1rem; margin: 0; }
  dt { color: var(--texte-2); }
  dd { margin: 0; text-align: right; font-weight: 600; }
  .vert { color: var(--succes); }
  .rouge { color: var(--danger); }
  .ligne { margin-bottom: 0.75rem; }
  .lien { display: block; color: var(--texte); text-decoration: none; }
  .lien:hover { border-color: var(--trait-fort); }
  .entete { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  .serre { margin-top: 0; }
  .decision { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--trait); }
  .choix { display: flex; gap: 1.5rem; margin-bottom: 1rem; }
  .onglets { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .onglets [aria-selected='true'] { border-color: var(--accent); background: var(--accent-doux); }
  .extrait { margin: 0.25rem 0; white-space: pre-line; }
  .pastille.urgent { background: var(--danger-doux); color: var(--danger); border-color: var(--danger); margin-right: 0.5rem; }
</style>
