// Lab entry for the home page: importing the page module mounts it (it finds <main>). Stubs stand in for lanes A/B.
// Fonts are linked and preloaded in home.html (local @fontsource files), like lane A's self-hosted subsets.
import '../../src/pages/home/page';

document.documentElement.dataset.ready = '1';
