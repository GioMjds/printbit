export function updateDirtyBarState(
  bar: HTMLElement | null,
  isDirty: boolean,
): void {
  if (!bar) return;
  if (isDirty) {
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}
