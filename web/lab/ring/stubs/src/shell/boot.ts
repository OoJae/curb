// LAB STUB for lane A's shell/boot.ts. Assumed signature: boot({ page }): Promise<void>.
// Real boot renders the masthead, regime chip, footer ledger, grain and favicon, and wires Lenis + View Transitions.
import { initLenis } from '../motion/lenis';

export async function boot({ page }: { page: string }): Promise<void> {
  document.documentElement.dataset.page = page;
  const regime = new URLSearchParams(location.search).get('regime');
  if (regime) document.documentElement.dataset.regime = regime; // ?regime=open|shut, as the spec's capture override
  initLenis();
}
