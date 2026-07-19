/**
 * Brand the vendored Electron binary for local `electron-vite dev`.
 *
 * macOS Dock hover + menu-bar title come from the .app bundle name and
 * Info.plist — app.setName() alone is not enough while the folder is still
 * called Electron.app.
 */
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'node_modules/electron/dist')
const pathTxt = join(root, 'node_modules/electron/path.txt')
const electronApp = join(dist, 'Electron.app')
const horatioApp = join(dist, 'Horatio.app')
const icnsSrc = join(root, 'build/icon.icns')

const NAME = 'Horatio'

function resolveApp() {
  if (existsSync(electronApp)) {
    if (existsSync(horatioApp)) rmSync(horatioApp, { recursive: true, force: true })
    renameSync(electronApp, horatioApp)
  }
  if (!existsSync(horatioApp)) {
    console.warn('[brand-electron] no Electron/Horatio.app found — skip')
    return null
  }
  return horatioApp
}

function patchPlist(appPath) {
  const plistPath = join(appPath, 'Contents/Info.plist')
  let plist = readFileSync(plistPath, 'utf8')
  plist = plist.replace(
    /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${NAME}$2`
  )
  plist = plist.replace(
    /(<key>CFBundleName<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${NAME}$2`
  )
  writeFileSync(plistPath, plist)
}

function patchIcon(appPath) {
  if (!existsSync(icnsSrc)) {
    console.warn('[brand-electron] build/icon.icns missing — skip icon')
    return
  }
  copyFileSync(icnsSrc, join(appPath, 'Contents/Resources/electron.icns'))
}

function patchPathTxt() {
  writeFileSync(pathTxt, 'Horatio.app/Contents/MacOS/Electron')
}

const app = resolveApp()
if (app) {
  patchPlist(app)
  patchIcon(app)
  patchPathTxt()
  console.log(`[brand-electron] ${NAME}.app ready (Dock name + icon)`)
}
