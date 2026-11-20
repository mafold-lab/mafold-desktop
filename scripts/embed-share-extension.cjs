// electron-builder's afterPack on macOS: put the share extension in the app.
//
// electron-builder skips Contents/PlugIns when it signs (and would give anything
// else the helpers' entitlements, with no sandbox, which macOS refuses to load),
// so the extension is signed here, before the app around it is.

const { execFileSync } = require("node:child_process");
const { cpSync, existsSync, mkdirSync } = require("node:fs");
const { join, resolve } = require("node:path");

const root = resolve(__dirname, "..");

/** The Developer ID in the release keychain; ad-hoc on a machine without one,
 *  the same way `-c.mac.identity=-` builds the rest of the app. */
function identity() {
  const keychain = process.env.CSC_KEYCHAIN;
  if (!keychain) return { args: ["--sign", "-"] };
  const found = execFileSync("security", ["find-identity", "-v", "-p", "codesigning", keychain], { encoding: "utf8" });
  const hash = found.match(/([0-9A-F]{40}) "Developer ID Application/)?.[1];
  if (!hash) throw new Error(`no Developer ID Application identity in ${keychain}`);
  return { args: ["--sign", hash, "--keychain", keychain, "--timestamp", "--options", "runtime"] };
}

exports.default = async function embedShareExtension(context) {
  if (context.electronPlatformName !== "darwin") return;
  const built = join(root, "share-extension", "build", "MafoldShare.appex");
  if (!existsSync(built)) execFileSync("bash", [join(root, "scripts", "build-share-extension.sh")], { stdio: "inherit" });

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const appex = join(app, "Contents", "PlugIns", "MafoldShare.appex");
  mkdirSync(join(app, "Contents", "PlugIns"), { recursive: true });
  cpSync(built, appex, { recursive: true });

  // What the share menu shows, and a version that says which app it came with.
  const version = context.packager.appInfo.version;
  const plist = join(appex, "Contents", "Info.plist");
  cpSync(join(app, "Contents", "Resources", "icon.icns"), join(appex, "Contents", "Resources", "icon.icns"));
  for (const [key, value] of [["CFBundleShortVersionString", version], ["CFBundleVersion", version]]) {
    execFileSync("plutil", ["-replace", key, "-string", value, plist]);
  }
  execFileSync("plutil", ["-insert", "CFBundleIconFile", "-string", "icon", plist]);

  const entitlements = join(root, "share-extension", "mac", "MafoldShare.entitlements");
  execFileSync("codesign", ["--force", ...identity().args, "--entitlements", entitlements, appex], { stdio: "inherit" });
};
