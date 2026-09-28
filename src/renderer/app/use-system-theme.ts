/** OSの配色を画面へ反映し、監視解除関数を返します。 */
export function useSystemTheme(media: MediaQueryList, root: HTMLElement): () => void {
  const apply = (): void => {
    root.classList.toggle("dark", media.matches);
  };
  apply();
  media.addEventListener("change", apply);
  return () => {
    media.removeEventListener("change", apply);
  };
}
