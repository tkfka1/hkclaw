import fs from 'fs';
import path from 'path';

const cachedTextAssets = new Map<
  string,
  { content: string; mtimeMs: number }
>();

function readTextAsset(relativePath: string): string {
  const filePath = path.join(process.cwd(), relativePath);
  const mtimeMs = fs.statSync(filePath).mtimeMs;
  const cached = cachedTextAssets.get(relativePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.content;

  const content = fs.readFileSync(filePath, 'utf-8');
  cachedTextAssets.set(relativePath, { content, mtimeMs });
  return content;
}

export function renderAdminGamePage(): string {
  return readTextAsset('src/admin-web-game.html');
}

export function renderAdminPhaserBundle(): string {
  return readTextAsset('node_modules/phaser/dist/phaser.min.js');
}
