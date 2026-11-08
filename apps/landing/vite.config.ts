import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite-plus";
import tailwindcss from "@tailwindcss/vite";

// The product version comes from the root manifest that release-please bumps, so a build of
// a release commit links that Release's DMG.
const rootManifest: unknown = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
const version =
  typeof rootManifest === "object" && rootManifest !== null && "version" in rootManifest
    ? String(rootManifest.version)
    : "";
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unexpected product version "${version}".`);

// Canonical and social URLs must be absolute. The Pages workflow passes the site's base URL.
const siteUrl = new URL(
  process.env.FACTORY_SITE_URL?.trim() || "https://alimek.github.io/t3-factory/",
).href.replace(/\/?$/, "/");

const placeholders: Record<string, string> = {
  "%FACTORY_VERSION%": version,
  "%SITE_URL%": siteUrl,
};
const fill = (source: string) =>
  source.replace(/%(FACTORY_VERSION|SITE_URL)%/g, (token) => placeholders[token] ?? token);

const sitePlaceholders = (): Plugin => ({
  name: "factory-landing-site",
  transformIndexHtml: fill,
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "robots.txt",
      source: fill("User-agent: *\nAllow: /\nSitemap: %SITE_URL%sitemap.xml\n"),
    });
    this.emitFile({
      type: "asset",
      fileName: "sitemap.xml",
      source: fill(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>%SITE_URL%</loc></url>\n</urlset>\n',
      ),
    });
  },
});

export default defineConfig({
  // Relative asset URLs work both at a project Pages path and at a custom domain root.
  base: "./",
  plugins: [tailwindcss(), sitePlaceholders()],
});
