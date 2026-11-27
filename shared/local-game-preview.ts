export const localGamePreviewHostPattern = /^opengame-preview-[a-f0-9]{24}\.localhost$/;

export function isLocalGamePreviewUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && !url.username && !url.password && Boolean(url.port)
      && localGamePreviewHostPattern.test(url.hostname)
      && /^\/(?:motion-)?api\/games\/[A-Za-z0-9_-]+\/play\/index\.html$/.test(url.pathname);
  } catch { return false; }
}
