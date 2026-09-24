// Lab entry for the home page: importing the page module mounts it (it finds <main>). Stubs stand in for lanes A/B.
// Fonts are served locally (like lane A's self-hosted subsets), so CLS here measures the page, not a CDN swap.
import '@fontsource-variable/bodoni-moda/opsz.css';
import '@fontsource-variable/bodoni-moda/opsz-italic.css';
import '@fontsource-variable/libre-franklin/wght.css';
import '@fontsource-variable/libre-franklin/wght-italic.css';
import '@fontsource-variable/martian-mono/standard.css';
import '../../src/pages/home/page';

document.documentElement.dataset.ready = '1';
