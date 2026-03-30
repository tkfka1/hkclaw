import fs from 'fs';
import path from 'path';

interface AdminMapMeta {
  tmjFile: string;
  projectFile: string;
  tilesetFile: string;
  tilesetName: string;
}

export interface AdminMapFileUpload {
  name: string;
  contentBase64: string;
}

export interface AdminMapUploadInput {
  mapFile?: AdminMapFileUpload;
  projectFile?: AdminMapFileUpload;
  tilesetFile?: AdminMapFileUpload;
}

export interface AdminMapState {
  version: string;
  tmjFile: string;
  tmjPath: string;
  tmjUrl: string;
  projectFile: string;
  projectPath: string;
  projectUrl: string;
  tilesetFile: string;
  tilesetPath: string;
  tilesetUrl: string;
  tilesetName: string;
}

const DEFAULT_META: AdminMapMeta = {
  tmjFile: 'hkclaw-office-rpg2000.tmj',
  projectFile: 'hkclaw-office-rpg2000.tiled-project',
  tilesetFile: 'rpg2000-office-tiles.svg',
  tilesetName: 'rpg2000-office-tiles',
};

function getAdminAssetsDir(projectRoot: string): string {
  return path.join(projectRoot, 'admin-assets');
}

function getMapMetaPath(projectRoot: string): string {
  return path.join(getAdminAssetsDir(projectRoot), 'hkclaw-office-map-meta.json');
}

function getBackupDir(projectRoot: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(getAdminAssetsDir(projectRoot), 'backups', stamp);
}

function decodeUploadFile(file: AdminMapFileUpload): Buffer {
  return Buffer.from(file.contentBase64, 'base64');
}

function parseTmj(buffer: Buffer): { tilesetName: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(buffer.toString('utf-8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `맵 JSON 파싱 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const tilesets = Array.isArray(parsed.tilesets) ? parsed.tilesets : [];
  const firstTileset = tilesets[0] as Record<string, unknown> | undefined;
  if (!firstTileset) {
    throw new Error('tileset 없는 tmj는 아직 안됨');
  }
  if (typeof firstTileset.source === 'string' && firstTileset.source.trim()) {
    throw new Error('외부 tsx source 맵은 아직 안됨');
  }

  const tilesetName = String(firstTileset.name || '').trim();
  if (!tilesetName) {
    throw new Error('tileset name 없는 tmj는 아직 안됨');
  }

  return { tilesetName };
}

function safeCopyIfExists(source: string, destinationDir: string): void {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.copyFileSync(source, path.join(destinationDir, path.basename(source)));
}

function writeMeta(projectRoot: string, meta: AdminMapMeta): void {
  fs.mkdirSync(getAdminAssetsDir(projectRoot), { recursive: true });
  fs.writeFileSync(
    getMapMetaPath(projectRoot),
    `${JSON.stringify(meta, null, 2)}\n`,
    'utf-8',
  );
}

function readMeta(projectRoot: string): AdminMapMeta {
  const metaPath = getMapMetaPath(projectRoot);
  if (!fs.existsSync(metaPath)) {
    return inferMetaFromDefaults(projectRoot);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Partial<AdminMapMeta>;
    return {
      tmjFile: parsed.tmjFile || DEFAULT_META.tmjFile,
      projectFile: parsed.projectFile || DEFAULT_META.projectFile,
      tilesetFile: parsed.tilesetFile || DEFAULT_META.tilesetFile,
      tilesetName: parsed.tilesetName || inferTilesetName(projectRoot, parsed.tmjFile || DEFAULT_META.tmjFile),
    };
  } catch {
    return inferMetaFromDefaults(projectRoot);
  }
}

function inferTilesetName(projectRoot: string, tmjFile: string): string {
  const tmjPath = path.join(getAdminAssetsDir(projectRoot), tmjFile);
  if (!fs.existsSync(tmjPath)) {
    return DEFAULT_META.tilesetName;
  }
  try {
    const buffer = fs.readFileSync(tmjPath);
    return parseTmj(buffer).tilesetName;
  } catch {
    return DEFAULT_META.tilesetName;
  }
}

function inferMetaFromDefaults(projectRoot: string): AdminMapMeta {
  return {
    ...DEFAULT_META,
    tilesetName: inferTilesetName(projectRoot, DEFAULT_META.tmjFile),
  };
}

function buildPublicUrl(fileName: string): string {
  return `/admin-assets/${encodeURIComponent(fileName)}`;
}

function statMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function cleanupGeneratedTilesets(projectRoot: string, keepFile: string): void {
  const dir = getAdminAssetsDir(projectRoot);
  fs.readdirSync(dir)
    .filter(
      (entry) =>
        entry.startsWith('hkclaw-office-tileset.') && entry !== keepFile,
    )
    .forEach((entry) => {
      fs.rmSync(path.join(dir, entry), { force: true });
    });
}

export function readAdminMapState(projectRoot: string): AdminMapState {
  const meta = readMeta(projectRoot);
  const assetsDir = getAdminAssetsDir(projectRoot);
  const tmjPath = path.join(assetsDir, meta.tmjFile);
  const projectPath = path.join(assetsDir, meta.projectFile);
  const tilesetPath = path.join(assetsDir, meta.tilesetFile);
  const version = Math.max(
    statMtime(tmjPath),
    statMtime(projectPath),
    statMtime(tilesetPath),
    statMtime(getMapMetaPath(projectRoot)),
  );

  return {
    version: String(version || Date.now()),
    tmjFile: meta.tmjFile,
    tmjPath,
    tmjUrl: buildPublicUrl(meta.tmjFile),
    projectFile: meta.projectFile,
    projectPath,
    projectUrl: buildPublicUrl(meta.projectFile),
    tilesetFile: meta.tilesetFile,
    tilesetPath,
    tilesetUrl: buildPublicUrl(meta.tilesetFile),
    tilesetName: meta.tilesetName,
  };
}

function assertUploadExtension(fileName: string, allowed: string[]): string {
  const ext = path.extname(fileName).toLowerCase();
  if (!allowed.includes(ext)) {
    throw new Error(`지원하지 않는 파일 형식: ${fileName}`);
  }
  return ext;
}

export function uploadAdminMapAssets(
  projectRoot: string,
  input: AdminMapUploadInput,
): AdminMapState {
  if (!input.mapFile && !input.projectFile && !input.tilesetFile) {
    throw new Error('업로드할 맵 파일이 없음');
  }

  const current = readAdminMapState(projectRoot);
  const assetsDir = getAdminAssetsDir(projectRoot);
  fs.mkdirSync(assetsDir, { recursive: true });

  const backupDir = getBackupDir(projectRoot);
  safeCopyIfExists(current.tmjPath, backupDir);
  safeCopyIfExists(current.projectPath, backupDir);
  safeCopyIfExists(current.tilesetPath, backupDir);
  safeCopyIfExists(getMapMetaPath(projectRoot), backupDir);

  const nextMeta: AdminMapMeta = {
    tmjFile: DEFAULT_META.tmjFile,
    projectFile: DEFAULT_META.projectFile,
    tilesetFile: current.tilesetFile,
    tilesetName: current.tilesetName,
  };

  if (input.mapFile) {
    assertUploadExtension(input.mapFile.name, ['.tmj', '.json']);
    const mapBuffer = decodeUploadFile(input.mapFile);
    const parsed = parseTmj(mapBuffer);
    fs.writeFileSync(path.join(assetsDir, DEFAULT_META.tmjFile), mapBuffer);
    nextMeta.tilesetName = parsed.tilesetName;
  }

  if (input.projectFile) {
    assertUploadExtension(input.projectFile.name, ['.tiled-project', '.json']);
    const projectBuffer = decodeUploadFile(input.projectFile);
    JSON.parse(projectBuffer.toString('utf-8'));
    fs.writeFileSync(
      path.join(assetsDir, DEFAULT_META.projectFile),
      projectBuffer,
    );
  }

  if (input.tilesetFile) {
    const ext = assertUploadExtension(input.tilesetFile.name, [
      '.svg',
      '.png',
      '.jpg',
      '.jpeg',
      '.webp',
      '.gif',
    ]);
    const nextTilesetFile = `hkclaw-office-tileset${ext}`;
    fs.writeFileSync(
      path.join(assetsDir, nextTilesetFile),
      decodeUploadFile(input.tilesetFile),
    );
    cleanupGeneratedTilesets(projectRoot, nextTilesetFile);
    nextMeta.tilesetFile = nextTilesetFile;
  }

  writeMeta(projectRoot, nextMeta);
  return readAdminMapState(projectRoot);
}
