import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { getWorkspaces } from '@craft-agent/shared/config'
import { loadWindowState } from './window-state'
import type { WindowManager } from './window-manager'
import { mainLog } from './logger'

let tray: Tray | null = null

function resolveTrayIconPath(): string | null {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  return [
    join(__dirname, 'resources', iconName),
    join(__dirname, '../resources', iconName),
  ].find(p => existsSync(p)) ?? null
}

function showExistingWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
}

function showOrCreateWindow(windowManager: WindowManager): void {
  const existing = windowManager.getLastActiveWindow()
  if (existing) {
    showExistingWindow(existing)
    return
  }

  const workspaces = getWorkspaces()
  if (workspaces.length === 0) return

  const savedState = loadWindowState()
  const workspaceId = savedState?.lastFocusedWorkspaceId && workspaces.some(ws => ws.id === savedState.lastFocusedWorkspaceId)
    ? savedState.lastFocusedWorkspaceId
    : workspaces[0].id
  windowManager.createWindow({ workspaceId })
}

function createNewWindow(windowManager: WindowManager): void {
  const focused = BrowserWindow.getFocusedWindow()
  const focusedWorkspaceId = focused
    ? windowManager.getWorkspaceForWindow(focused.webContents.id)
    : null
  const lastActive = windowManager.getLastActiveWindow()
  const lastActiveWorkspaceId = lastActive
    ? windowManager.getWorkspaceForWindow(lastActive.webContents.id)
    : null
  const workspaces = getWorkspaces()
  const fallbackWorkspaceId = workspaces[0]?.id
  const targetWorkspaceId = focusedWorkspaceId ?? lastActiveWorkspaceId ?? fallbackWorkspaceId
  if (!targetWorkspaceId) return
  windowManager.createWindow({ workspaceId: targetWorkspaceId })
}

export function createAppTray(windowManager: WindowManager): Tray | null {
  if (tray || process.platform !== 'win32') return tray

  const iconPath = resolveTrayIconPath()
  if (!iconPath) {
    mainLog.warn('[tray] App tray icon not found')
    return null
  }

  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon)
  tray.setToolTip('Craft Agents')
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Show Craft Agents',
      click: () => showOrCreateWindow(windowManager),
    },
    {
      label: 'New Window',
      click: () => createNewWindow(windowManager),
    },
    { type: 'separator' },
    {
      label: 'Quit Craft Agents',
      click: () => app.quit(),
    },
  ]))

  tray.on('double-click', () => showOrCreateWindow(windowManager))
  tray.on('click', () => showOrCreateWindow(windowManager))
  mainLog.info('[tray] Windows tray initialized')
  return tray
}

export function destroyAppTray(): void {
  if (!tray) return
  tray.destroy()
  tray = null
}
