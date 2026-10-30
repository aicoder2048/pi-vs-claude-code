// electron-builder re-adds Electron's permissive ATS block (arbitrary loads plus a
// plain-HTTP 127.0.0.1 exception) after extendInfo. The app only calls HTTPS model
// APIs, so drop the block before signing and let macOS apply its secure default.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const plist = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Info.plist');
  execFileSync('plutil', ['-remove', 'NSAppTransportSecurity', plist]);
};
