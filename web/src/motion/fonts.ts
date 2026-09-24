/** Resolves once web fonts are ready (never rejects; 3 s cap so a stuck font cannot block intros). */
let fontsReady: Promise<void> | null = null;

export function whenFontsReady(): Promise<void> {
  if (!fontsReady) {
    const ready = typeof document !== 'undefined' && document.fonts ? document.fonts.ready : Promise.resolve();
    fontsReady = Promise.race([ready, new Promise((r) => setTimeout(r, 3000))]).then(() => undefined);
  }
  return fontsReady;
}
