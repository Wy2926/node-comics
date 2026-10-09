/** Only the protocol is shared; each site owns its URLs and resource attribution. */
export interface ComiciSite {
  id: string;
  name: string;
  origin: string;
  searchPageSize: number;
  location(url: URL): {seriesId: string | undefined; episodeId: string | undefined} | null;
  catalogUrl(id: string): string;
  episodeUrl(id: string, series?: string): string;
  imageUrl(url: URL, viewerId: string): boolean;
}
