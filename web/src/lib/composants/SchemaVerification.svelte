<!-- Parcours de vérification (relecture, relecture élargie, jury ; publiée, rejetée ou en débat). Livre blanc et
     Comment ça marche. Aucun chiffre de règle : ils changent (page Règles). -->
<figure class="schema">
  <svg viewBox="0 0 760 330" role="img" aria-label="Parcours de vérification : relecture, relecture élargie si le vote est serré, puis jury ; la vidéo est publiée, rejetée ou classée en débat">
    <defs>
      <marker id="verif-fleche" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0 0L10 5L0 10z" class="pointe" />
      </marker>
    </defs>
    <rect x="24" y="24" width="712" height="44" rx="8" class="issue-oui" />
    <text x="380" y="51" text-anchor="middle" class="nom">Publiée sur la carte et archivée</text>
    <rect x="24" y="262" width="712" height="44" rx="8" class="cadre" />
    <text x="380" y="289" text-anchor="middle" class="nom">Rejetée, non archivée</text>

    <g class="liens" marker-end="url(#verif-fleche)">
      <path d="M99 129V68" /><path d="M289 129V68" /><path d="M479 129V68" />
      <path d="M99 201V262" /><path d="M289 201V262" /><path d="M479 201V262" />
      <path d="M174 165H214" /><path d="M364 165H404" /><path d="M554 165H600" />
    </g>

    <rect x="24" y="129" width="150" height="72" rx="8" class="cadre" />
    <text x="99" y="153" text-anchor="middle" class="nom">Relecture</text>
    <text x="99" y="173" text-anchor="middle" class="detail">relecteurs</text>
    <text x="99" y="189" text-anchor="middle" class="detail">tirés au sort</text>

    <rect x="214" y="129" width="150" height="72" rx="8" class="cadre" />
    <text x="289" y="153" text-anchor="middle" class="nom">Relecture élargie</text>
    <text x="289" y="173" text-anchor="middle" class="detail">d’autres relecteurs</text>
    <text x="289" y="189" text-anchor="middle" class="detail">tirés au sort</text>

    <rect x="404" y="129" width="150" height="72" rx="8" class="cadre" />
    <text x="479" y="153" text-anchor="middle" class="nom">Jury</text>
    <text x="479" y="173" text-anchor="middle" class="detail">comptes anciens</text>
    <text x="479" y="189" text-anchor="middle" class="detail">et fiables</text>

    <rect x="600" y="129" width="136" height="72" rx="8" class="cadre" />
    <text x="668" y="153" text-anchor="middle" class="nom">En débat</text>
    <text x="668" y="173" text-anchor="middle" class="detail">visible, mais</text>
    <text x="668" y="189" text-anchor="middle" class="detail">hors de la carte</text>

    <text x="107" y="104" class="detail">assez de oui</text>
    <text x="297" y="104" class="detail">assez de oui</text>
    <text x="487" y="104" class="detail">majorité de oui</text>
    <text x="107" y="236" class="detail">trop de non</text>
    <text x="297" y="236" class="detail">trop de non</text>
    <text x="487" y="236" class="detail">majorité de non</text>
    <text x="194" y="157" text-anchor="middle" class="detail">serré</text>
    <text x="384" y="157" text-anchor="middle" class="detail">serré</text>
    <text x="577" y="185" text-anchor="middle" class="detail petit-mot">sinon</text>
  </svg>
</figure>

<style>
  .schema { margin: 1.5rem 0; overflow-x: auto; }
  /* Sur téléphone : le schéma garde une taille lisible et défile, comme les tableaux. */
  .schema svg { width: 100%; min-width: 620px; height: auto; display: block; font-family: var(--police); font-size: 13px; }
  .schema .cadre { fill: none; stroke: var(--trait-fort); stroke-width: 1.25; }
  .schema .issue-oui { fill: var(--accent-doux); stroke: var(--accent); stroke-width: 2; }
  .schema .liens { fill: none; stroke: var(--trait-fort); stroke-width: 1.25; }
  .schema .pointe { fill: var(--trait-fort); }
  .schema .nom { fill: var(--texte); font-weight: 600; }
  .schema .detail { fill: var(--texte-2); font-size: 11.5px; }
  .schema .petit-mot { font-size: 10.5px; }
</style>
