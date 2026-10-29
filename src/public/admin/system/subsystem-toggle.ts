export function attachSubsystemCardToggles(): void {
  const cards = document.querySelectorAll<HTMLElement>('.status-card');
  cards.forEach((card) => {
    const head = card.querySelector<HTMLElement>('.status-card__head');
    if (head && !head.dataset.toggleBound) {
      head.dataset.toggleBound = 'true';
      head.style.cursor = 'pointer';
      head.setAttribute('role', 'button');
      head.setAttribute('tabindex', '0');
      head.setAttribute(
        'aria-expanded',
        card.classList.contains('is-expanded') ? 'true' : 'false',
      );

      const toggle = () => {
        const isExp = card.classList.toggle('is-expanded');
        head.setAttribute('aria-expanded', isExp ? 'true' : 'false');
      };

      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    }
  });
}
