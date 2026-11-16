// Thème choisi par la personne (clair par défaut), appliqué avant l'affichage de la page.
try {
  if (localStorage.getItem('argos-theme') === 'sombre') document.documentElement.dataset.theme = 'sombre';
} catch (e) { /* stockage indisponible : thème clair */ }
