// Thème clair (par défaut) ou sombre, choisi par la personne et gardé dans ce navigateur.
export const theme = $state<{ valeur: 'clair' | 'sombre' }>({
  valeur: typeof document !== 'undefined' && document.documentElement.dataset.theme === 'sombre' ? 'sombre' : 'clair',
});

export function basculer() {
  theme.valeur = theme.valeur === 'clair' ? 'sombre' : 'clair';
  if (theme.valeur === 'sombre') document.documentElement.dataset.theme = 'sombre';
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem('argos-theme', theme.valeur);
  } catch { /* stockage indisponible : le choix vaut pour cette page */ }
}
