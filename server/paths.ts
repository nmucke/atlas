import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
export function atlasDataDirectory() {
  const fallback =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Atlas')
      : process.platform === 'win32'
        ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Atlas')
        : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'atlas');
  return resolve(process.env.ATLAS_DATA_DIR || fallback);
}
