import { defineRouteMiddleware } from '@astrojs/starlight/route-data';

// Untranslated pages are served under /de/ as an English fallback. To avoid
// duplicate content in search results, point them to the English original
// and keep them out of the index.
export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  if (!route.isFallback) return;
  const enUrl = new URL(context.url.pathname.replace(/^\/SignaVis\/de\//, '/SignaVis/'), context.site);
  for (const entry of route.head) {
    if (entry.tag === 'link' && entry.attrs?.rel === 'canonical') entry.attrs.href = enUrl.href;
  }
  route.head.push({ tag: 'meta', attrs: { name: 'robots', content: 'noindex, follow' } });
});
