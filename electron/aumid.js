import { app } from 'electron'

/**
 * AppUserModelID — process-level Windows identity.
 *
 * There is no main window to stamp any more, but the ID still decides how
 * Windows groups our process and attributes notifications. Why plugin mode
 * gets its own: Windows caches per-AUMID state (taskbar icon included), so
 * the plugin shell must not merge with an installed copy on the same machine
 * — nor inherit a stale icon from an early dev launch.
 */
export const APP_USER_MODEL_ID = app.isPackaged
  ? 'com.icather.dsh-clean-desktop-shell'
  : 'com.icather.dsh-clean-desktop-shell.plugin'
