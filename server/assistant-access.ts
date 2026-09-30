import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

const tokenPattern = /^[a-f0-9]{64}$/;
export async function readAssistantToken(directory: string) {
  let token: string;
  try {
    token = (await readFile(join(directory, 'assistant-token'), 'utf8')).trim();
  } catch {
    throw new Error(
      'Start Atlas with npm start before connecting the assistant. Check ATLAS_DATA_DIR.',
    );
  }
  if (!tokenPattern.test(token)) throw new Error('Invalid Atlas assistant credential.');
  return token;
}
export async function loadAssistantToken(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = join(directory, 'assistant-token');
  try {
    await writeFile(filename, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (process.platform !== 'win32') await chmod(filename, 0o600);
  return readAssistantToken(directory);
}
export function authorizedAssistant(header: string | undefined, token: string) {
  const supplied = header?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  return !!supplied && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
}
export function assistantOrigin(port = process.env.ATLAS_PORT || '3210') {
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1024 || number > 65535)
    throw new Error('ATLAS_PORT must be an integer from 1024 to 65535');
  return `http://127.0.0.1:${number}`;
}
