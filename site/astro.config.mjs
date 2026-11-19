// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Site lives at https://limitlessgreen.github.io/SignaVis/ (landing) and /docs/ (Starlight).
// The app itself stays at /demo/labeling-app.html and is built by the root Vite config.
export default defineConfig({
  site: 'https://limitlessgreen.github.io',
  base: '/SignaVis',
  integrations: [
    starlight({
      title: 'SignaVis',
      logo: { src: './src/assets/logo.svg', replacesTitle: false },
      favicon: '/favicon.svg',
      defaultLocale: 'root',
      locales: { root: { label: 'Deutsch', lang: 'de' } },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/LimitlessGreen/SignaVis' }],
      customCss: ['@fontsource-variable/inter', './src/styles/m3-tokens.css', './src/styles/starlight-m3.css'],
      sidebar: [
        { label: 'Los geht’s', items: [{ label: 'Willkommen', link: '/docs/' }] },
        { label: 'Was willst du tun?', items: [{ autogenerate: { directory: 'docs/anwendungsfaelle' } }] },
        { label: 'Funktionen', items: [{ autogenerate: { directory: 'docs/funktionen' } }] },
      ],
    }),
  ],
});
