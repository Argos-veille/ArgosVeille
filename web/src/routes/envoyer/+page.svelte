<script lang="ts">
  // Envoyer une vidéo. 1 fichier → 2 description → 3 code de suivi (12 mots, 3 à retaper)
  // → 4 envoi chiffré → 5 terminé. Rien n'est envoyé avant l'étape 4.
  // Connecté, on peut envoyer avec son compte : la vidéo se suit dans « Mes vidéos », le code devient
  // facultatif (il reste la seule clé de l'original non flouté).
  import Manque from '#lib/composants/Manque.svelte';
  import Info from '#lib/composants/Info.svelte';
  import { lirePasse, obtenirPasseEtRecharger } from '#lib/passe-envoi.ts';
  import { clesAdmin as lireClesAdmin } from '#lib/cles-admin.ts';
  import { correctifsCopie, scellerCode, creerCleVideo, deriverSecrets, genererEntropie, indicateur, lecteurBlob, lireMetadonnees, phraseDepuisEntropie, sansAccents, type Metadonnees, entropieVideo, lirePhrase, VIDEOS_PAR_CODE } from 'argos-navigateur';
  import CarteLieu from '#lib/composants/CarteLieu.svelte';
  import { envoyerVideo, lienPrisEnCharge, videosDuCode, type Phase, type Precision, type Ouvert } from '#lib/envoi.ts';
  import { message } from '#lib/erreurs.ts';
  import { CATEGORIES, FORCES, SITUATIONS, SOUS_CATEGORIES } from '#lib/libelles.ts';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { get } from '#lib/api.ts';
  import { publiqueDuCompte, publiqueOuverte } from '#lib/messagerie.ts';
  import DeverrouillerMessagerie from '#lib/composants/DeverrouillerMessagerie.svelte';
  import { session } from '#lib/session.svelte.ts';

  const SOUS = {
    violence: ['strikes', 'disproportionate_force', 'weapons', 'chokehold', 'other_violence'],
    abuse: ['contested_arrest', 'discriminatory_stop', 'insults', 'intimidation', 'filming_obstruction',
            'property_destruction', 'complaint_refused', 'other_abuse'],
  } as const;
  const TAILLE_MAX = 2 * 1024 ** 3;
  const DUREE_MAX_S = 300;   // 5 minutes (même limite que le worker, ARGOS_DUREE_MAX)

  /** Durée d'une vidéo lue par le navigateur (null s'il ne sait pas la lire : le serveur vérifiera). */
  function dureeVideo(f: File): Promise<number | null> {
    return new Promise((ok) => {
      const v = document.createElement('video');
      const url = URL.createObjectURL(f);
      const fin = (d: number | null) => { URL.revokeObjectURL(url); ok(d); };
      v.preload = 'metadata';
      v.onloadedmetadata = () => fin(Number.isFinite(v.duration) ? v.duration : null);
      v.onerror = () => fin(null);
      setTimeout(() => fin(null), 10_000);
      v.src = url;
    });
  }

  let etape = $state<1 | 2 | 3 | 4 | 5>(1);
  let erreur = $state('');
  // 1. Fichier
  let fichier = $state<File | null>(null);
  let provenance = $state<'fichier' | 'lien'>('fichier');
  let lienVideo = $state('');
  const lienValable = $derived(lienPrisEnCharge(lienVideo));
  let meta = $state<Metadonnees>({});
  let nettoyable = $state(false);   // MP4 / MOV : lieu et date retirés de la copie dans le navigateur
  // Anonyme par défaut, même connecté ; « avec mon compte » déjà choisi au retour de la connexion.
  let avecCompte = $state(page.url.searchParams.has('compte'));
  // Arrivée depuis une fiche publique : « Vous avez filmé la même scène ? » (une proposition, à valider).
  const ficheEvenement = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(page.url.searchParams.get('evenement') ?? '')?.[0];
  let lierEvenement = $state(true);
  const doitSeConnecter = $derived(avecCompte && session.chargee && !session.moi);
  // 2. Description
  let categorie = $state<'violence' | 'abuse' | ''>('');
  const MAX_CHOIX = 3;   // « Plus précisément » et « Situation » : le premier coché est le choix principal
  let sousCategories = $state<string[]>([]);
  let forces = $state('');
  let situations = $state<string[]>([]);
  let jour = $state('');           // AAAA-MM-JJ, obligatoire
  let heure = $state('');          // HH:MM, facultative
  let heureInconnue = $state(false);
  let dateInconnue = $state(false);   // date à établir : « au plus tard le », l'heure n'est pas demandée
  let lieuInconnu = $state(false);    // lieu à établir : repère posé au plus près, gardé à la commune
  let lieu = $state<{ lat: number; lon: number } | null>(null);
  let precision = $state<Precision>('approx_100m');
  let description = $state('');
  let origine = $state({ publiePar: '', lien: '', precisions: '', publique: false });
  const origineRemplie = $derived(!!(origine.publiePar.trim() || origine.lien.trim() || origine.precisions.trim()));
  const lienOrigineValable = $derived(!origine.lien.trim() || /^https:\/\/\S+$/.test(origine.lien.trim()));
  let garderSon = $state(true);
  let masquerVisages = $state(true);
  let conditions = $state(false);   // conditions d'utilisation acceptées
  // Transmission de l'original : proposée seulement si le site a une clé d'administration.
  let clesAdmin = $state<string[]>([]);
  let autoriser = $state(false);
  // Messagerie : accepter d'être contacté par des journalistes, avocats ou associations vérifiés (non par défaut).
  let contact = $state(false);
  onMount(() => { lireClesAdmin().then((c) => (clesAdmin = c)).catch(() => {}); });

  // B11 : le test anti-robot passe AVANT, puis la page se recharge sans le script de Cloudflare ; le code de 12 mots
  // n'est créé et affiché que dans cette page propre.
  let pret = $state(false);
  onMount(() => {
    if (lirePasse()) { pret = true; return; }
    obtenirPasseEtRecharger().catch((x) => { erreur = message(x); });
  });
  // 3. Code de suivi
  let entropie = $state<Uint8Array | null>(null);
  let mots = $state<string[]>([]);
  let controle = $state<number[]>([]);
  let saisies = $state(['', '', '']);
  let note = $state(false);          // « J'ai noté mon code » coché
  let verification = $state(false);  // mots masqués, trois à retaper
  let revoir = $state(false);        // revoir le code une dernière fois, après l'envoi
  // 4–5. Envoi
  let phase = $state<Phase>('preparation');
  let part = $state(0);
  let resultat = $state<{ pseudonyme: string } | null>(null);

  const taille = (o: number) => (o > 1e9 ? `${(o / 1e9).toFixed(1)} Go` : `${(o / 1e6).toFixed(1)} Mo`);
  const versLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

  async function choisir(e: Event) {
    erreur = '';
    const f = (e.currentTarget as HTMLInputElement).files?.[0] ?? null;
    if (!f) return;
    if (f.size > TAILLE_MAX) { erreur = 'Ce fichier dépasse 2 Go.'; return; }
    if (!f.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm)$/i.test(f.name)) { erreur = 'Choisissez un fichier vidéo (MP4, MOV, WebM).'; return; }
    const duree = await dureeVideo(f);
    if (duree !== null && duree > DUREE_MAX_S + 1) {
      erreur = 'Cette vidéo dépasse 5 minutes : gardez seulement le passage qui montre les faits, puis envoyez-la.';
      return;
    }
    fichier = f;
    // Métadonnées lues ici, dans le navigateur : elles ne préremplissent que la date et le lieu.
    meta = await lireMetadonnees(lecteurBlob(f)).catch(() => ({}));
    nettoyable = (await correctifsCopie(lecteurBlob(f)).catch(() => null)) !== null;
    if (meta.date && !jour) { const l = versLocal(meta.date); jour = l.slice(0, 10); heure = l.slice(11, 16); heureInconnue = false; }
    if (meta.position && !lieu) lieu = { ...meta.position };
  }

  const heureOk = $derived(heureInconnue || dateInconnue || /^\d{2}:\d{2}$/.test(heure));
  $effect(() => { if (lieuInconnu) precision = 'municipality'; });
  // Description obligatoire, 20 caractères au moins (comme l'API, DESCRIPTION_MIN).
  const DESCRIPTION_MIN = 20;
  const descriptionOk = $derived([...description.trim()].length >= DESCRIPTION_MIN);
  const descriptionComplete = $derived(!!(categorie && sousCategories.length && forces && situations.length && jour && heureOk && lieu && descriptionOk));
  // Ce qui manque encore, dit sous le bouton grisé (sinon on ne comprend pas pourquoi il ne s'active pas).
  const manquants = $derived([
    ...(!categorie || !sousCategories.length ? ['la nature des faits'] : []), ...(!forces ? ['les forces'] : []),
    ...(!situations.length ? ['la situation'] : []), ...(!jour || !heureOk ? ['la date et l’heure'] : []),
    ...(!lieu ? [lieuInconnu ? 'un repère approximatif sur la carte' : 'le lieu sur la carte'] : []),
    ...(!descriptionOk ? [`ce qui s’est passé (${DESCRIPTION_MIN} caractères au moins)`] : []),
    ...(!lienOrigineValable ? ['un lien d’origine valable (https://…)'] : []),
    ...(!conditions ? ['la case des conditions'] : []),
  ]);
  /** Instant des faits : la date à l'heure indiquée, ou à midi si l'heure est inconnue (jamais affichée alors). */
  const instant = () => new Date(`${jour}T${heureInconnue || dateInconnue ? '12:00' : heure}`);

  // Code déjà utilisé pour d'autres vidéos : retapé à chaque envoi, jamais gardé par le navigateur.
  let codeExistant = $state(false);
  let saisieCode = $state('');
  let erreurCode = $state('');
  let verifCode = $state(false);

  async function utiliserCodeExistant() {
    erreurCode = ''; verifCode = true;
    try {
      const lu = await lirePhrase(saisieCode);
      if (!lu.ok) { erreurCode = 'Code illisible : vérifiez les 12 mots et leur ordre.'; return; }
      const videos = await videosDuCode(lu.entropie);
      const prises = new Set(videos.map((v) => v.position));
      const libre = Array.from({ length: VIDEOS_PAR_CODE }, (_, n) => n).find((n) => !prises.has(n));
      if (libre === undefined) { erreurCode = 'Ce code a atteint le maximum de vidéos : créez-en un nouveau.'; return; }
      entropie = await entropieVideo(lu.entropie, libre);
      mots = await phraseDepuisEntropie(lu.entropie);
      saisieCode = '';
      await envoyer();
    } catch (x) {
      erreurCode = message(x) === 'Introuvable.' ? 'Aucune vidéo ne correspond à ce code (une vidéo retirée n’est plus liée à son code).' : message(x);
    } finally {
      verifCode = false;
    }
  }

  // Envoi avec un compte qui a sa clé : le code est gardé, chiffré pour ce compte. Rien à noter. La clé est celle que le
  // mot de passe a ouverte dans ce navigateur, jamais celle que renvoie le serveur (N1) ; sinon : déverrouiller d'abord.
  let publiqueCompte = $state<string | null>(null);
  let compteACle = $state(false);

  async function versCode() {
    publiqueCompte = avecCompte && session.moi ? publiqueOuverte() : null;
    compteACle = avecCompte && !!session.moi && !publiqueCompte && !!(await publiqueDuCompte().catch(() => null));
    entropie = genererEntropie();
    mots = await phraseDepuisEntropie(entropie);
    const positions = new Set<number>();
    while (positions.size < 3) positions.add(crypto.getRandomValues(new Uint32Array(1))[0]! % 12);
    controle = [...positions].sort((a, b) => a - b);
    saisies = ['', '', ''];
    note = false;
    verification = false;
    etape = 3;
  }

  function telechargerCode() {
    const liste = mots.map((m, i) => `${i + 1}. ${m}`).join('\n');
    // Fichier volontairement neutre (nom et contenu sans le nom du site) : trouvé sur un appareil saisi, il ne doit pas
    // désigner la personne comme source d'une vidéo.
    const texte = avecCompte
      ? `Clé de l'original\n\n${liste}\n\n`
        + `Seule clé de l'original non flouté. Elle sera demandée pour autoriser plus tard sa transmission. Personne d'autre\n`
        + `ne la connaît et elle ne peut pas être retrouvée.\n`
      : `Code de suivi\n\n${liste}\n\n`
        + `À garder en lieu sûr, hors du téléphone qui a filmé si possible. Sans lui, personne ne peut suivre ni retirer\n`
        + `la vidéo. Personne d'autre ne le connaît et il ne peut pas être retrouvé.\n`;
    const url = URL.createObjectURL(new Blob([texte], { type: 'text/plain;charset=utf-8' }));
    Object.assign(document.createElement('a'), { href: url, download: 'notes.txt' }).click();
    URL.revokeObjectURL(url);
  }

  /** Mot retapé : accents et majuscules indifférents ; le mot entier, ou ses 4 premières lettres (comme au suivi). */
  function motCorrect(saisie: string, attendu: string) {
    const s = sansAccents(saisie).replace(/[^a-z]/g, '');   // copier-coller : numéro, espaces, retours ignorés
    const a = sansAccents(attendu);
    return s === a || (s.length === 4 && a.startsWith(s));
  }
  const codeVerifie = $derived(controle.length === 3 && controle.every((p, i) => motCorrect(saisies[i]!, mots[p]!)));

  // Après un échec, « Réessayer » reprend le même envoi (le code de suivi ne peut servir qu'une fois).
  let envoiOuvert: Ouvert | undefined;

  async function envoyer() {
    erreur = '';
    etape = 4;
    try {
      const secrets = await deriverSecrets(entropie!);
      // Clé de messagerie de la vidéo : ouvrable avec les 12 mots et, pour un envoi avec compte, avec la clé du compte.
      const parCompte = avecCompte && !!session.moi;
      const messagerie = await creerCleVideo(entropie!, (parCompte ? publiqueCompte : null) ?? undefined);
      const date = instant();
      // Date ou lieu à établir : rien de fiable à comparer avec la vidéo.
      const ind = dateInconnue || lieuInconnu ? 'absentes' : indicateur(meta, { date, lat: lieu!.lat, lon: lieu!.lon, precision, heureConnue: !heureInconnue });
      const r = await envoyerVideo(provenance === 'lien' ? null : fichier, secrets, {
        date: date.toISOString(), lieu: lieu!, precision, forces, situation: situations[0]!, autresSituations: situations.slice(1), categorie,
        sousCategorie: sousCategories[0]!, autresSousCategories: sousCategories.slice(1),
        description: description.trim(), langue: 'fr', heureConnue: !heureInconnue && !dateInconnue,
        ...(dateInconnue ? { dateAEtablir: true } : {}), ...(lieuInconnu ? { lieuAEtablir: true } : {}),
      }, { metadonnees: ind, garderSon, masquerVisages, avecCompte: avecCompte && !!session.moi, evenement: ficheEvenement && lierEvenement ? ficheEvenement : undefined,
          ...(origineRemplie ? { origine: { ...(origine.publiePar.trim() ? { publiePar: origine.publiePar.trim() } : {}), ...(origine.lien.trim() ? { lien: origine.lien.trim() } : {}),
                                            ...(origine.precisions.trim() ? { precisions: origine.precisions.trim() } : {}), publique: origine.publique && !!origine.publiePar.trim() } } : {}),
          ...(autoriser && clesAdmin.length && provenance === 'fichier' ? { autoriser: { cles: clesAdmin, entropie: entropie! } } : {}),
          ...(provenance === 'lien' ? { lien: { url: lienVideo.trim(), entropie: entropie! } } : {}),
          ...(publiqueCompte ? { codeScelle: await scellerCode(entropie!, publiqueCompte) } : {}),
          messagerie, contact, ouvert: envoiOuvert, surOuverture: (o) => { envoiOuvert = o; } }, (ph, p) => { phase = ph; part = p; });
      resultat = { pseudonyme: r.pseudonyme };
      etape = 5;
    } catch (x) {
      erreur = message(x);
    }
  }

  const PHASES: Record<Phase, string> = {
    preparation: 'Préparation de la vidéo', original: 'Envoi de l’original chiffré',
    copie: 'Envoi de la copie à flouter', finalisation: 'Finalisation',
  };
  const POIDS: Record<Phase, [number, number]> = { preparation: [0, 0.1], original: [0.1, 0.55], copie: [0.55, 0.98], finalisation: [0.98, 1] };
  const global = $derived(POIDS[phase][0] + (POIDS[phase][1] - POIDS[phase][0]) * part);
</script>

<svelte:head><title>Envoyer une vidéo — Argos Veille</title></svelte:head>

<div class="conteneur texte-long">
  <span class="surtitre">Envoyer une vidéo</span>
  <h1>{etape === 5 ? 'Votre vidéo est reçue' : 'Envoyer une vidéo'}</h1>
  <ol class="etapes" aria-label="Étapes">
    {#each ['Vidéo', 'Description', 'Code de suivi', 'Envoi'] as nom, i (nom)}
      <li class:active={etape === i + 1} class:faite={etape > i + 1}>{nom}</li>
    {/each}
  </ol>
  {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}
  {#if !pret}
    {#if !erreur}<div class="carte"><p class="second">Vérification anti-robot en cours…</p></div>{/if}
  {:else}

  {#if etape === 1}
    <div class="carte"><fieldset class="mode">
        <legend class="etiquette">Comment voulez-vous l’envoyer ?</legend>
        <label class="case"><input type="radio" name="mode" value={false} bind:group={avecCompte} />
          <span><strong>Anonymement</strong> (conseillé) — {session.moi ? 'sans lien avec votre compte' : 'sans compte'}. Vous suivrez la vidéo avec un code de 12 mots.</span></label>
        {#if !avecCompte}
          <p class="petit second">Votre adresse IP et l’heure de l’envoi sont gardées un an, comme la loi l’impose, et la justice
            peut les demander. Pour ne pas pouvoir être identifié, même ainsi, envoyez avec Tor ou un VPN.</p>
        {/if}
        <label class="case"><input type="radio" name="mode" value={true} bind:group={avecCompte} />
          <span><strong>Avec mon compte{session.moi ? ` (${session.moi.pseudo})` : ''}</strong> — vous la suivez dans « Mes vidéos »
            et recevez un mail à chaque étape.</span></label>
        {#if avecCompte}
          <p class="petit second">Votre compte sera lié à cette vidéo, et la justice peut le demander. Pour rester anonyme,
            choisissez « Anonymement ».</p>
        {/if}
        {#if doitSeConnecter}
          <p class="second">Connectez-vous d’abord : vous reviendrez ici ensuite.</p>
          <div class="boutons">
            <a class="bouton principal" href="/connexion?retour=%2Fenvoyer%3Fcompte">Se connecter</a>
            <a class="bouton" href="/inscription">Créer un compte</a>
          </div>
        {/if}
      </fieldset></div>
    {#if ficheEvenement}
      <label class="case"><input type="checkbox" bind:checked={lierEvenement} />
        <span>Ma vidéo montre le même événement que <a href="/videos/{ficheEvenement}" target="_blank" rel="noopener">cette fiche</a>.</span></label>
    {/if}
    {#if !avecCompte}
      <div class="message info">Ni compte, ni téléphone, ni mail.{provenance === 'fichier' ? ' L’original est chiffré avant de partir.' : ''} Tor et VPN bienvenus.</div>
    {/if}
    {#if !doitSeConnecter}
    <div class="choix provenance">
      <label class:choisi={provenance === 'fichier'}><input type="radio" name="provenance" value="fichier" bind:group={provenance} /> Un fichier</label>
      <label class:choisi={provenance === 'lien'}><input type="radio" name="provenance" value="lien" bind:group={provenance} /> Un lien</label>
    </div>
    <p class="petit discret">Plusieurs scènes ? Envoyez une vidéo par scène.</p>
    {#if provenance === 'lien'}
      <div class="carte">
        <div class="champ">
          <label for="lien-video">Lien de la vidéo</label>
          <input id="lien-video" type="url" maxlength="2048" placeholder="https://…" bind:value={lienVideo} autocomplete="off" />
          <span class="aide">X, Bluesky, Facebook, TikTok, Instagram ou YouTube, 5 minutes au plus. Un lien de partage ne marche pas toujours : ouvrez-le, puis copiez l’adresse complète de la vidéo.<Info>Notre serveur récupère la vidéo, la voit en clair le temps de la chiffrer et de la flouter, puis oublie le lien. Si vous avez le fichier, l’envoyer directement est plus sûr.</Info></span>
        </div>
        {#if lienVideo.trim() && !lienValable}<div class="message erreur petit">Ce site n’est pas pris en charge : téléchargez la vidéo et envoyez le fichier.</div>{/if}
        <div class="boutons"><Manque raisons={[!lienValable && 'un lien X, Bluesky, Facebook, TikTok, Instagram ou YouTube']}><button class="bouton principal" disabled={!lienValable} onclick={() => (etape = 2)}>Continuer</button></Manque></div>
      </div>
    {:else}
    <div class="carte">
      <label class="depot">
        <input type="file" accept="video/*,.mp4,.mov,.m4v,.webm" onchange={choisir} />
        <strong>{fichier ? fichier.name : 'Choisir la vidéo'}</strong>
        <span class="petit discret">{fichier ? taille(fichier.size) : 'MP4, MOV ou WebM, 5 minutes et 2 Go au plus'}</span>
      </label>
      {#if fichier}
        <p class="petit second">
          {#if meta.date || meta.position}
            Date{meta.position ? ' et lieu' : ''} lus dans la vidéo pour préremplir.
            {nettoyable ? 'Ils sont retirés avant l’envoi ; seul l’original, chiffré, les garde.' : 'Le GPS exact n’est jamais publié : il est retiré au traitement.'}
          {:else}
            Pas de date ni de lieu dans la vidéo : vous les indiquerez ensuite.
          {/if}
          {#if !nettoyable && /\.(mp4|mov|m4v)$/i.test(fichier.name)}
            <!-- B8 : nettoyage impossible dans le navigateur : la source le sait avant d'envoyer. -->
            <strong>Attention :</strong> les données de localisation de ce fichier n’ont pas pu être retirées dans votre
            navigateur. Notre serveur les retire au traitement, mais il les voit un court instant.
          {/if}
        </p>
        <div class="boutons"><button class="bouton principal" onclick={() => (etape = 2)}>Continuer</button></div>
      {/if}
    </div>
    {/if}
    {/if}

  {:else if etape === 2}
    <form class="carte" onsubmit={(e) => { e.preventDefault(); void versCode(); }}>
      <fieldset class="champ">
        <legend class="etiquette">Ce que montre la vidéo</legend>
        <div class="choix">
          {#each Object.entries(CATEGORIES) as [cle, texte] (cle)}
            <label class:choisi={categorie === cle}><input type="radio" name="categorie" value={cle} bind:group={categorie}
                   onchange={() => (sousCategories = [])} /> {texte}</label>
          {/each}
        </div>
        <p class="discret petit">Si la vidéo montre les deux, choisissez le plus grave.</p>
      </fieldset>
      {#if categorie}
        <fieldset class="champ">
          <legend class="etiquette">Plus précisément</legend>
          <p class="discret petit">Jusqu’à {MAX_CHOIX} choix, le principal d’abord.</p>
          {@render casesChoix(SOUS[categorie], SOUS_CATEGORIES, sousCategories, (v) => (sousCategories = v))}
        </fieldset>
      {/if}
      <div class="champ">
        <label for="forces">Forces de l’ordre</label>
        <select id="forces" bind:value={forces} required>
          <option value="" disabled>Choisir…</option>
          {#each Object.entries(FORCES) as [cle, texte] (cle)}<option value={cle}>{texte}</option>{/each}
        </select>
      </div>
      <fieldset class="champ">
        <legend class="etiquette">Situation</legend>
        <p class="discret petit">Jusqu’à {MAX_CHOIX} choix, le principal d’abord.</p>
        {@render casesChoix(Object.keys(SITUATIONS), SITUATIONS, situations, (v) => (situations = v))}
      </fieldset>
      <div class="deux">
        <div class="champ">
          <label for="jour">{dateInconnue ? 'Au plus tard le' : 'Date des faits'}</label>
          <input id="jour" type="date" bind:value={jour} required max={versLocal(new Date()).slice(0, 10)} />
          <label class="case petit"><input type="checkbox" bind:checked={dateInconnue} />
            <span>Je ne connais pas la date précise<Info>Indiquez le premier jour où vous avez vu la vidéo. Des analystes
              chercheront la date avant toute publication.</Info></span></label>
        </div>
        {#if !dateInconnue}
          <div class="champ">
            <label for="heure">Heure</label>
            <input id="heure" type="time" bind:value={heure} disabled={heureInconnue} required={!heureInconnue} />
            <label class="case petit"><input type="checkbox" bind:checked={heureInconnue} />
              <span>Je ne connais pas l’heure précise</span></label>
          </div>
        {/if}
      </div>
      <div class="champ">
        <span class="etiquette">Lieu des faits</span>
        <span class="aide">{lieuInconnu ? 'Placez le repère au plus près de ce que vous savez (ville, département).'
          : 'Cliquez sur la carte, puis déplacez le repère si besoin. La zone colorée montre ce qui sera gardé.'}</span>
        <CarteLieu bind:lieu {precision} suggestion={meta.position ?? null} />
        <label class="case petit"><input type="checkbox" bind:checked={lieuInconnu} />
          <span>Je ne connais pas le lieu précis<Info>Des analystes chercheront le lieu avant toute publication.</Info></span></label>
      </div>
      {#if !lieuInconnu}
      <fieldset class="champ">
        <legend class="etiquette">Précision du lieu gardée<Info>Le fichier original, chiffré, garde de toute façon la position
          exacte : elle pourra servir de preuve, avec votre accord.</Info></legend>
        <label class="case"><input type="radio" name="precision" value="approx_100m" bind:group={precision} /> <span>À 100 m près (conseillé)</span></label>
        <label class="case"><input type="radio" name="precision" value="municipality" bind:group={precision} /> <span>La commune seulement</span></label>
        <label class="case"><input type="radio" name="precision" value="exact" bind:group={precision} /> <span>Le lieu précis (peut révéler une adresse)</span></label>
      </fieldset>
      {/if}
      <details class="origine-bloc">
        <summary>Cette vidéo a été publiée par quelqu’un ? (facultatif)</summary>
        <div class="champ"><label for="origine-nom">Publiée par (nom ou compte)</label>
          <input id="origine-nom" maxlength="200" bind:value={origine.publiePar} /></div>
        <div class="champ"><label for="origine-lien">Lien vers la publication</label>
          <input id="origine-lien" type="url" maxlength="500" placeholder="https://…" bind:value={origine.lien} aria-invalid={!lienOrigineValable || undefined} /></div>
        <div class="champ"><label for="origine-precisions">Ce qu’elle indique (lieu, contexte…)</label>
          <textarea id="origine-precisions" rows="2" maxlength="2000" bind:value={origine.precisions}></textarea></div>
        <label class="case"><input type="checkbox" bind:checked={origine.publique} disabled={!origine.publiePar.trim()} />
          <span>Citer cette personne sur la fiche publique<Info>À réserver aux comptes publics, comme un journaliste ou un média. Pour un témoin, ne cochez pas : relecteurs et analystes verront quand même l’information.</Info></span></label>
      </details>
      <div class="champ">
        <label for="description">Ce qui s’est passé</label>
        <textarea id="description" bind:value={description} maxlength="5000" required minlength={DESCRIPTION_MIN} aria-describedby="description-aide"
                  placeholder="Les faits, tels que vous les avez vus."></textarea>
        <span class="aide" id="description-aide">Racontez ce qui s’est passé avant et pendant la vidéo : sans contexte, elle ne peut être ni vérifiée
          ni comprise. N’écrivez rien qui vous identifie, vous ou d’autres personnes.</span>
      </div>
      <label class="case"><input type="checkbox" bind:checked={masquerVisages} /> <span>Flouter automatiquement les visages (conseillé ; vous vérifierez le résultat)</span></label>
      <label class="case"><input type="checkbox" bind:checked={garderSon} /> <span>Garder le son (votre voix, si on l’entend, peut vous faire reconnaître)</span></label>
      <label class="case"><input type="checkbox" bind:checked={contact} />
        <span>J’accepte d’être contacté au sujet de cette vidéo par des journalistes, avocats ou associations vérifiés
          (facultatif).<Info>Ils ne verront ni votre compte ni rien qui vous identifie : seulement le nom de la vidéo. Les
          messages sont chiffrés : Argos Veille ne peut pas les lire. Vous les lirez dans le suivi de la vidéo, et vous pourrez
          retirer votre accord à tout moment.</Info></span></label>
      {#if clesAdmin.length && provenance === 'fichier'}
        <label class="case"><input type="checkbox" bind:checked={autoriser} />
          <span>J’autorise Argos Veille à transmettre l’original <strong>non flouté</strong> à une association, un avocat ou un
            journaliste, si l’administration le juge utile (facultatif).<Info>L’original reste chiffré : seule l’administration
            peut l’ouvrir, jamais le serveur. Chaque transmission est inscrite au journal public (sans nom) et vous en êtes
            prévenu. Vous pouvez retirer cette autorisation à tout moment. Attention : sur décision de justice, Argos Veille
            pourrait être obligé de remettre l’original.</Info></span></label>
      {/if}
      <label class="case conditions"><input type="checkbox" bind:checked={conditions} required />
        <span>Je certifie que cette vidéo est authentique, qu’elle montre une intervention des forces de l’ordre et que j’ai
          le droit de la partager. J’ai lu et j’accepte les <a href="/conditions" target="_blank">conditions d’utilisation</a>.</span></label>
      <div class="boutons">
        <Manque raisons={manquants}><button class="bouton principal" type="submit" disabled={!descriptionComplete || !conditions || !lienOrigineValable}>Continuer</button></Manque>
        <button class="bouton lien" type="button" onclick={() => (etape = 1)}>Retour</button>
      </div>
    </form>

  {:else if etape === 3}
    <div class="carte">
      {#if avecCompte && publiqueCompte}
      <h2>Rien à noter</h2>
      <p class="second">Le code de cette vidéo reste lié à votre compte, chiffré : vous seul pouvez le rouvrir, dans « Mes vidéos », avec votre mot de passe.<Info>Le site ne peut pas le lire. Si vous oubliez votre mot de passe, l’original non flouté devient illisible ; la vidéo floutée et son suivi ne sont pas touchés.</Info></p>
      <div class="boutons">
        <button class="bouton principal" onclick={envoyer}>Chiffrer et envoyer la vidéo</button>
        <button class="bouton lien" onclick={() => (etape = 2)}>Retour</button>
      </div>
      {:else if avecCompte}
      {#if compteACle}
        <p class="second">Pour lier le code à votre compte (rien à noter), déverrouillez d’abord votre messagerie.</p>
        <DeverrouillerMessagerie ouverte={(c) => { publiqueCompte = c.publique; compteACle = false; }} />
      {/if}
      <h2>La clé de l’original (facultatif)</h2>
      <p class="second">Inutiles pour suivre la vidéo (Mes vidéos), mais <strong>seule clé de l’original non flouté</strong> :
        ils vous seront demandés pour le transmettre plus tard à une association, un avocat ou un journaliste.
        Gardez-les si besoin.</p>
      <ol class="mots">{#each mots as m, i (i)}<li><span class="n">{i + 1}</span> {m}</li>{/each}</ol>
      <div class="boutons"><button class="bouton" onclick={telechargerCode}>Télécharger (fichier texte)</button></div>
      <div class="boutons">
        <button class="bouton principal" onclick={envoyer}>Chiffrer et envoyer la vidéo</button>
        <button class="bouton lien" onclick={() => (etape = 2)}>Retour</button>
      </div>
      {:else}
      <h2>Votre code de suivi</h2>
      <fieldset class="mode">
        <label class="case"><input type="radio" name="code" value={false} bind:group={codeExistant} /> <span>Nouveau code (conseillé)</span></label>
        <label class="case"><input type="radio" name="code" value={true} bind:group={codeExistant} />
          <span>J’ai déjà un code<Info>Pratique pour suivre plusieurs vidéos. Mais si quelqu’un obtient ce code, il voit toutes les
            vidéos envoyées avec. Chaque vidéo reste séparée pour les relecteurs et les contacts.</Info></span></label>
      </fieldset>
      {#if codeExistant}
        <div class="message attention">Si quelqu’un obtient ce code, il voit toutes vos vidéos envoyées avec.</div>
        {#if erreurCode}<div class="message erreur" role="alert">{erreurCode}</div>{/if}
        <div class="champ">
          <label for="code-existant">Vos 12 mots</label>
          <textarea id="code-existant" bind:value={saisieCode} rows="3" autocomplete="off" autocapitalize="none" spellcheck="false"></textarea>
        </div>
        <div class="boutons">
          <Manque raisons={[!verifCode && !saisieCode.trim() && 'les 12 mots du code']}><button class="bouton principal" onclick={utiliserCodeExistant} disabled={verifCode || !saisieCode.trim()}>Chiffrer et envoyer la vidéo</button></Manque>
          <button class="bouton lien" onclick={() => (etape = 2)}>Retour</button>
        </div>
      {:else}
      <p class="second">Ces 12 mots sont la seule clé de votre vidéo : suivi, floutage, messages, retrait.
        <strong>Argos Veille ne peut pas les retrouver.</strong> Notez-les.</p>
      {#if !verification}
        <ol class="mots">{#each mots as m, i (i)}<li><span class="n">{i + 1}</span> {m}</li>{/each}</ol>
        <div class="boutons"><button class="bouton" onclick={telechargerCode}>Télécharger (fichier texte)</button></div>
        <label class="case">
          <input type="checkbox" bind:checked={note} />
          <span>J’ai noté mon code en lieu sûr.<Info>Sur papier, ou dans un fichier hors du téléphone qui a filmé. Sans lui,
            personne ne pourra suivre ni retirer la vidéo.</Info></span>
        </label>
        <div class="boutons">
          <Manque raisons={[!note && 'la case « J’ai noté mon code en lieu sûr »']}><button class="bouton principal" disabled={!note} onclick={() => (verification = true)}>Continuer</button></Manque>
          <button class="bouton lien" onclick={() => (etape = 2)}>Retour</button>
        </div>
      {:else}
      <h3>Vérification</h3>
      <p class="petit second">Retapez ces trois mots (les 4 premières lettres suffisent, sans souci d’accents).</p>
      <div class="controle">
        {#each controle as p, i (p)}
          <div class="champ">
            <label for="mot-{i}">Mot n° {p + 1}</label>
            <input id="mot-{i}" bind:value={saisies[i]} autocomplete="off" autocapitalize="none" spellcheck="false"
                   aria-invalid={saisies[i] && sansAccents(saisies[i]!).replace(/[^a-z]/g, '').length >= 4 && !motCorrect(saisies[i]!, mots[p]!) ? 'true' : undefined} />
          </div>
        {/each}
      </div>
      <div class="boutons">
        <Manque raisons={[!codeVerifie && 'les 3 mots demandés, bien recopiés']}><button class="bouton principal" onclick={envoyer} disabled={!codeVerifie}>Chiffrer et envoyer la vidéo</button></Manque>
        <button class="bouton lien" onclick={() => { verification = false; note = false; }}>Revoir mon code</button>
      </div>
      {/if}
      {/if}
      {/if}
    </div>

  {:else if etape === 4}
    <div class="carte">
      <h2>{PHASES[phase]}</h2>
      <div class="progression" class:en-cours={!erreur} role="progressbar" aria-valuenow={Math.round(global * 100)} aria-valuemin="0" aria-valuemax="100">
        <span style:width="{Math.round(global * 100)}%"></span>
      </div>
      <p class="petit second">{#if !erreur}<span class="point-actif" aria-hidden="true"></span>{/if}{Math.round(global * 100)} % — gardez cette page ouverte.</p>
      {#if erreur}
        <div class="boutons"><button class="bouton principal" onclick={envoyer}>Réessayer</button></div>
      {/if}
    </div>

  {:else}
    <div class="message succes">Merci, votre vidéo est bien reçue. Elle n’est pas encore publiée : il reste quelques étapes.</div>
    <div class="carte">
      <p>Son nom : <strong>{resultat?.pseudonyme}</strong>.</p>
      <h2>Et maintenant ?</h2>
      <ol class="suite">
        <li><strong>Floutage</strong> : automatique, quelques minutes.</li>
        <li><strong>Votre vérification</strong> : vous contrôlez le floutage, puis vous validez. Sans réponse sous 7 jours, la vidéo part en relecture.</li>
        <li><strong>Relecture</strong> : des relecteurs tirés au sort vérifient la vidéo.</li>
        <li><strong>Décision</strong> : la vidéo est publiée sur la carte, ou non.</li>
      </ol>
      {#if avecCompte}
        <p class="second">Un mail vous préviendra quand le floutage sera prêt (pensez aux indésirables).</p>
        <div class="boutons"><a class="bouton principal" href="/compte/videos">Aller à Mes vidéos</a></div>
      {:else}
        <p class="second">Revenez dans quelques minutes sur la page de suivi, avec votre code.</p>
        <div class="boutons"><a class="bouton principal" href="/suivi">{codeExistant ? 'Suivre mes vidéos' : 'Aller à la page de suivi'}</a></div>
      {/if}
    </div>
    {#if !publiqueCompte && !codeExistant}
    <div class="carte">
      <h2>{avecCompte ? 'La clé de l’original' : 'Votre code de suivi'}</h2>
      {#if !revoir}
        <p class="second">Un doute ? Revoyez-le une dernière fois, avant de quitter cette page.</p>
        <button class="bouton" onclick={() => (revoir = true)}>Revoir mon code</button>
      {:else}
        <ol class="mots">{#each mots as m, i (i)}<li><span class="n">{i + 1}</span> {m}</li>{/each}</ol>
        <div class="boutons"><button class="bouton" onclick={telechargerCode}>Télécharger (fichier texte)</button></div>
      {/if}
    </div>
    {/if}
  {/if}
  {/if}
</div>

{#snippet casesChoix(codes: readonly string[], noms: Record<string, string>, valeur: string[], changer: (v: string[]) => void)}
  <div class="choix">
    {#each codes as code (code)}
      {@const coche = valeur.includes(code)}
      <label class:choisi={coche}>
        <input type="checkbox" checked={coche} disabled={!coche && valeur.length >= MAX_CHOIX}
               onchange={() => changer(coche ? valeur.filter((c) => c !== code) : [...valeur, code])} />
        {noms[code]}{#if valeur.length > 1 && valeur[0] === code}<span class="discret">{' · principal'}</span>{/if}
      </label>
    {/each}
  </div>
{/snippet}

<style>
  .depot { display: grid; gap: 0.25rem; justify-items: center; text-align: center; padding: 2.5rem 1rem; cursor: pointer;
           border: 2px dashed var(--trait-fort); border-radius: var(--rayon-grand); }
  .depot:hover, .depot:focus-within { border-color: var(--accent); }
  .depot input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  fieldset { border: 0; padding: 0; margin: 0 0 1.125rem; }
  .choix { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .choix label { border: 1px solid var(--trait-fort); border-radius: var(--rayon); padding: 0.5rem 1rem; cursor: pointer; }
  .choix label:has(input:disabled) { opacity: 0.5; cursor: not-allowed; }
  .choix label.choisi { border-color: var(--accent); background: var(--accent-doux); font-weight: 600; }
  .deux { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  @media (max-width: 34rem) { .deux { grid-template-columns: 1fr; } }
  .mots { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; list-style: none; padding: 1rem; margin: 0;
          background: var(--surface-2); border-radius: var(--rayon); font-family: var(--police-mono); font-size: 1.0625rem; }
  @media (max-width: 34rem) { .mots { grid-template-columns: repeat(2, 1fr); } }
  .mots .n { color: var(--texte-3); font-size: 0.8125rem; display: inline-block; min-width: 1.5rem; }
  .controle { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
  @media (max-width: 34rem) { .controle { grid-template-columns: 1fr; } }
  .progression { margin: 1rem 0 0.5rem; }
  .mode { display: grid; gap: 0.5rem; margin: 0; }
  .provenance { margin: 0 0 1rem; }
  .origine-bloc { margin: 0 0 1.125rem; }
  .origine-bloc summary { cursor: pointer; font-weight: 600; margin-bottom: 0.5rem; }
  .suite { display: grid; gap: 0.375rem; padding-left: 1.25rem; }
</style>
