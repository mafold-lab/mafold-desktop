// Where bundled files are. `static/` (the offline page, the strings snapshot)
// lives inside the app archive; `resources/` (icons) is shipped beside it as
// real files (electron-builder `extraResources`), because Windows notifications
// and the tray read icons from a path the OS can open — not one inside app.asar.

import { join } from "node:path";
import { app } from "electron";

export const staticPath = (...p: string[]): string => join(app.getAppPath(), "static", ...p);

export const resourcePath = (...p: string[]): string =>
  app.isPackaged ? join(process.resourcesPath, "resources", ...p) : join(app.getAppPath(), "resources", ...p);
