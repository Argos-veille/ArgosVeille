// Rafraîchit régulièrement une page (nouveaux messages…), seulement quand l'onglet est visible, et tout de suite au
// retour sur l'onglet. Renvoie la fonction d'arrêt (à rendre depuis un $effect ou onMount).
export function surveiller(action: () => unknown, intervalleMs: number): () => void {
  let enCours = false;
  const tick = async () => {
    if (enCours || document.visibilityState !== 'visible') return;
    enCours = true;
    try { await action(); } catch { /* réessayé au prochain tour */ } finally { enCours = false; }
  };
  const minuteur = setInterval(tick, intervalleMs);
  const retour = () => { if (document.visibilityState === 'visible') void tick(); };
  document.addEventListener('visibilitychange', retour);
  return () => { clearInterval(minuteur); document.removeEventListener('visibilitychange', retour); };
}
