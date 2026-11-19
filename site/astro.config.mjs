// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import { readdirSync } from 'node:fs';

// German pages that really exist; other /de/docs/ URLs are English fallbacks
// (noindex, see src/route-data.ts) and stay out of the sitemap.
const deDocs = new Set(
  readdirSync(new URL('./src/content/docs/de/docs/', import.meta.url), { recursive: true })
    .filter((f) => /\.mdx?$/.test(f))
    .map((f) => f.replace(/\\/g, '/').replace(/(^|\/)index\.mdx?$/, '$1').replace(/\.mdx?$/, '/')),
);

const SITE = 'https://limitlessgreen.github.io';
// Kept from the old hand-written landing page so Search Console stays verified.
const GOOGLE_VERIFICATION = 'LQaceaYKsZF6elDYBWZfJyz8RE2UzSP5u9QXgMI9xNk';
const OG_IMAGE = `${SITE}/SignaVis/media/og-image.png`;

// Site lives at https://limitlessgreen.github.io/SignaVis/ (landing) and /docs/ (Starlight).
// The app itself stays at /demo/labeling-app.html and is built by the root Vite config.
export default defineConfig({
  site: SITE,
  trailingSlash: 'always',
  base: '/SignaVis',
  integrations: [
    sitemap({
      i18n: { defaultLocale: 'en', locales: { en: 'en', de: 'de' } },
      // The app is built by Vite, outside Astro, but should be in the sitemap.
      customPages: [`${SITE}/SignaVis/demo/labeling-app.html`],
      filter: (page) => {
        const m = page.match(/\/SignaVis\/de\/docs\/(.*)$/);
        return !m || deDocs.has(m[1]);
      },
    }),
    starlight({
      title: 'SignaVis',
      logo: { src: './src/assets/logo.svg', replacesTitle: false },
      favicon: '/favicon.svg',
      defaultLocale: 'root',
      // English at the root, German under /de/. Same file paths in both locales.
      locales: {
        root: { label: 'English', lang: 'en' },
        de: { label: 'Deutsch', lang: 'de' },
      },
      routeMiddleware: './src/route-data.ts',
      head: [
        { tag: 'meta', attrs: { name: 'google-site-verification', content: GOOGLE_VERIFICATION } },
        { tag: 'meta', attrs: { property: 'og:image', content: OG_IMAGE } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
      ],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/LimitlessGreen/SignaVis' }],
      customCss: ['@fontsource-variable/inter', './src/styles/m3-tokens.css', './src/styles/starlight-m3.css'],
      sidebar: [
        { label: 'Start', translations: { de: 'Start' }, items: [{ label: 'Overview', translations: { de: 'Übersicht' }, link: '/docs/' }, { label: 'Getting started', translations: { de: 'Erste Schritte' }, link: '/docs/getting-started/' }, { label: 'The interface', translations: { de: 'Die Oberfläche' }, link: '/docs/interface/' }] },
        { label: 'Guides', translations: { de: 'Anleitungen' }, items: [{ autogenerate: { directory: 'docs/use-cases' } }] },
        { label: 'Features', translations: { de: 'Funktionen' }, items: [{ autogenerate: { directory: 'docs/features' } }] },
        { label: 'Python', items: [{ autogenerate: { directory: 'docs/python' } }] },
        {
          label: 'Reference', translations: { de: 'Nachschlagen' },
          items: [
            { label: 'Keyboard shortcuts', translations: { de: 'Tastenkürzel' }, slug: 'docs/labeling/shortcuts' },
            { label: 'Species format', translations: { de: 'Artenformat' }, slug: 'docs/labeling/species-format' },
            { label: 'Xeno-canto format', translations: { de: 'Xeno-canto-Format' }, slug: 'docs/labeling/xeno-canto-format' },
            { label: 'Cite SignaVis', translations: { de: 'SignaVis zitieren' }, link: '/docs/cite/' },
          ],
        },
        {
          label: 'Developers', translations: { de: 'Für Entwickler' }, collapsed: true,
          // Imported from ../docs by scripts/import-dev-docs.mjs; URLs match the old MkDocs site.
          items: [
            { label: 'Player options', slug: 'docs/usage/player-options' },
            { label: 'Integration examples', slug: 'docs/usage/integration' },
            { label: 'Python integration', slug: 'docs/python-integration' },
            { label: 'Labeling app', slug: 'docs/labeling' },
            { label: 'Labeling: Python', slug: 'docs/labeling/python-integration' },
            { label: 'SignaVis Lite', slug: 'docs/signavis-lite' },
            { label: 'Lite privacy policy', slug: 'docs/signavis-lite-privacy' },
            { label: 'Deployment', slug: 'docs/deployment' },
            { label: 'Future plans', slug: 'docs/future-plans' },
            { label: 'ADR 001', slug: 'docs/architecture/adr-001-plattform-grundlagen' },
          ],
        },
      ],
    }),
  ],
});
