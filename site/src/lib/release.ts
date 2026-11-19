// Latest SignaVis release, fetched at build time. The download page refreshes
// it in the browser, so a new release shows up before the next site deploy.
export const REPO = 'LimitlessGreen/SignaVis';
export const RELEASES_URL = `https://github.com/${REPO}/releases`;

export interface Asset { name: string; url: string; size: number }
export interface Release { tag: string; date: string; url: string; assets: Asset[] }

const FALLBACK: Release = { tag: '', date: '', url: `${RELEASES_URL}/latest`, assets: [] };

export async function latestRelease(): Promise<Release> {
  try {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();
    return {
      tag: r.tag_name,
      date: r.published_at,
      url: r.html_url,
      assets: r.assets.map((a: any) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
    };
  } catch (e) {
    console.warn(`[download] latest release unavailable, links fall back to GitHub: ${e}`);
    return FALLBACK;
  }
}

/** Download slots, matched against asset file names. Order = display order. */
export const SLOTS = [
  { id: 'win-exe', os: 'windows', pattern: /_x64-setup\.exe$/, primary: true },
  { id: 'win-msi', os: 'windows', pattern: /_x64_en-US\.msi$/ },
  { id: 'mac-dmg', os: 'macos', pattern: /_aarch64\.dmg$/, primary: true },
  { id: 'linux-appimage', os: 'linux', pattern: /_amd64\.AppImage$/, primary: true },
  { id: 'linux-deb', os: 'linux', pattern: /_amd64\.deb$/ },
] as const;
export type SlotId = (typeof SLOTS)[number]['id'];

export const findAsset = (r: Release, pattern: RegExp) => r.assets.find((a) => pattern.test(a.name));
export const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
