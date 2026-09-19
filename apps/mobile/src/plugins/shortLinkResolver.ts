import { Plugin, WebPlugin } from "@capacitor/core";

export interface ShortLinkResolverPlugin extends Plugin {
  resolve(options: { url: string }): Promise<{ url: string }>;
}

export class ShortLinkResolverWeb extends WebPlugin implements ShortLinkResolverPlugin {
  async resolve(options: { url: string }): Promise<{ url: string }> {
    // Web fallback - use the existing fetch-based implementation
    const { resolveShortLink } = await import("../utils/location");
    const finalUrl = await resolveShortLink(options.url);
    return { url: finalUrl };
  }
}