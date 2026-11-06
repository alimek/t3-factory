// electron-builder configuration for the macOS Apple Silicon release. Signing, notarization
// and the release feed are deployment prerequisites supplied by the environment:
//   CSC_LINK / CSC_KEY_PASSWORD (Developer ID Application certificate),
//   APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER (notarization),
//   FACTORY_UPDATE_URL (generic feed reachable by approved recipients) or
//   FACTORY_UPDATE_GITHUB_OWNER / FACTORY_UPDATE_GITHUB_REPO (public GitHub Releases).
// Without a feed the package reports updates as unsupported instead of pointing at the
// private source repository with a shared token.
import { readFileSync } from "node:fs";

const { factoryBuild } = JSON.parse(
  readFileSync(new URL("stage/package.json", import.meta.url), "utf8"),
);
const release = factoryBuild.channel === "release";
const generic = process.env.FACTORY_UPDATE_URL;
const owner = process.env.FACTORY_UPDATE_GITHUB_OWNER;
const repo = process.env.FACTORY_UPDATE_GITHUB_REPO;
const publish = generic
  ? [{ provider: "generic", url: generic }]
  : owner && repo
    ? [{ provider: "github", owner, repo, releaseType: "release" }]
    : null;
const signed = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

export default {
  appId: "dev.t3factory.desktop",
  productName: "T3 Factory",
  // electron-builder's default ${version} drops SemVer build metadata.
  // Match GitHub's download names so update metadata and checksums use the same URLs.
  artifactName: `T3.Factory-${factoryBuild.version}-\${arch}.\${ext}`,
  copyright: "T3 Factory",
  directories: { app: "stage", output: "release", buildResources: "resources" },
  files: ["build/**/*", "!build/**/*.map", "package.json"],
  asar: true,
  asarUnpack: ["build/native/fs-ext/build/Release/*.node"],
  // stage.mjs already rebuilt the one native module for this Electron ABI.
  npmRebuild: false,
  nodeGypRebuild: false,
  electronFuses: {
    // The reporting bridge runs this executable as Node (ELECTRON_RUN_AS_NODE).
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  mac: {
    target: [
      { target: "dmg", arch: ["arm64"] },
      // Squirrel.Mac installs updates from the zip.
      { target: "zip", arch: ["arm64"] },
    ],
    category: "public.app-category.developer-tools",
    // macOS bundle version fields stay numeric; package/app and artifact versions carry Git identity.
    bundleVersion: factoryBuild.baseVersion,
    bundleShortVersion: factoryBuild.baseVersion,
    icon: "resources/icon.png",
    minimumSystemVersion: "13.0",
    // Notarization requires the hardened runtime; ad-hoc developer packages cannot use it.
    hardenedRuntime: signed,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.mac.plist",
    entitlementsInherit: "resources/entitlements.mac.plist",
    // Apple Silicon kills unsigned binaries, and fuse flipping voids Electron's linker
    // signature: developer packages are ad-hoc signed ("-"), which is not a release signature.
    identity: signed ? undefined : "-",
    notarize: signed && Boolean(process.env.APPLE_API_KEY),
  },
  dmg: { sign: false },
  // Local builds never attach to a release feed, even if release credentials are in the shell.
  publish: release ? publish : null,
};
