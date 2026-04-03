import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readJsonFile, writeJsonFile } from './utils.js';

export interface TemperamentDefinition {
  temperamentId: string;
  name: string;
  prompt: string;
  updatedAt: string;
  builtin?: boolean;
}

export interface ServiceTemperamentProfile {
  serviceId: string;
  temperamentId: string;
  temperamentName: string;
  prompt: string;
  updatedAt: string;
}

type ServiceTemperamentAssignmentStore = Record<
  string,
  {
    temperamentId?: string;
    updatedAt?: string;
  }
>;

type TemperamentDefinitionStore = Record<
  string,
  {
    name?: string;
    prompt?: string;
    updatedAt?: string;
  }
>;

const BUILTIN_TEMPERAMENTS: TemperamentDefinition[] = [
  {
    temperamentId: 'normal',
    name: 'normal',
    prompt: '',
    updatedAt: '',
    builtin: true,
  },
  {
    temperamentId: 'concierge',
    name: 'concierge',
    prompt:
      'Be polished, proactive, and service-minded. Keep replies warm, concise, and operationally helpful.',
    updatedAt: '',
    builtin: true,
  },
  {
    temperamentId: 'analyst',
    name: 'analyst',
    prompt:
      'Think like a blunt analyst. Prioritize structure, risk calls, tradeoffs, and direct recommendations over small talk.',
    updatedAt: '',
    builtin: true,
  },
  {
    temperamentId: 'dispatcher',
    name: 'dispatcher',
    prompt:
      'Act like a floor dispatcher. Route work clearly, confirm ownership, keep status tight, and push decisions forward.',
    updatedAt: '',
    builtin: true,
  },
  {
    temperamentId: 'caretaker',
    name: 'caretaker',
    prompt:
      'Act calm and supportive. Reduce chaos, summarize cleanly, and guide the user without being verbose.',
    updatedAt: '',
    builtin: true,
  },
];

export function normalizeTemperamentId(
  value: string | undefined | null,
): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return normalized || 'normal';
}

function resolveDataPath(
  projectRoot: string = process.cwd(),
  fileName: string,
): string {
  if (projectRoot === process.cwd()) {
    return path.join(DATA_DIR, fileName);
  }
  return path.join(projectRoot, 'data', fileName);
}

export function getServiceTemperamentStorePath(
  projectRoot: string = process.cwd(),
): string {
  return resolveDataPath(projectRoot, 'service-temperaments.json');
}

export function getTemperamentDefinitionStorePath(
  projectRoot: string = process.cwd(),
): string {
  return resolveDataPath(projectRoot, 'temperaments.json');
}

function readAssignments(
  projectRoot?: string,
): ServiceTemperamentAssignmentStore {
  return (
    readJsonFile<ServiceTemperamentAssignmentStore>(
      getServiceTemperamentStorePath(projectRoot),
    ) || {}
  );
}

function writeAssignments(
  projectRoot: string | undefined,
  store: ServiceTemperamentAssignmentStore,
): void {
  const filePath = getServiceTemperamentStorePath(projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJsonFile(filePath, store, true);
}

function readDefinitions(projectRoot?: string): TemperamentDefinitionStore {
  return (
    readJsonFile<TemperamentDefinitionStore>(
      getTemperamentDefinitionStorePath(projectRoot),
    ) || {}
  );
}

function writeDefinitions(
  projectRoot: string | undefined,
  store: TemperamentDefinitionStore,
): void {
  const filePath = getTemperamentDefinitionStorePath(projectRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJsonFile(filePath, store, true);
}

export function listTemperaments(projectRoot: string): TemperamentDefinition[] {
  const custom = readDefinitions(projectRoot);
  const merged = new Map(
    BUILTIN_TEMPERAMENTS.map((entry) => [entry.temperamentId, entry]),
  );

  Object.entries(custom).forEach(([temperamentId, entry]) => {
    const normalizedId = normalizeTemperamentId(temperamentId);
    merged.set(normalizedId, {
      temperamentId: normalizedId,
      name: entry.name?.trim() || normalizedId,
      prompt: entry.prompt?.trim() || '',
      updatedAt: entry.updatedAt || '',
      builtin: false,
    });
  });

  return [...merged.values()].sort((left, right) => {
    if (left.temperamentId === 'normal') return -1;
    if (right.temperamentId === 'normal') return 1;
    if (Boolean(left.builtin) !== Boolean(right.builtin)) {
      return left.builtin ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

export function getTemperamentDefinition(
  projectRoot: string,
  temperamentId: string,
): TemperamentDefinition {
  const normalizedId = normalizeTemperamentId(temperamentId);
  return (
    listTemperaments(projectRoot).find(
      (entry) => entry.temperamentId === normalizedId,
    ) || BUILTIN_TEMPERAMENTS[0]
  );
}

export function getServiceTemperament(
  projectRoot: string,
  serviceId: string,
): ServiceTemperamentProfile {
  const assignment = readAssignments(projectRoot)[serviceId] || {};
  const temperamentId = normalizeTemperamentId(assignment.temperamentId);
  const definition = getTemperamentDefinition(projectRoot, temperamentId);

  return {
    serviceId,
    temperamentId: definition.temperamentId,
    temperamentName: definition.name,
    prompt: definition.prompt,
    updatedAt: assignment.updatedAt || definition.updatedAt || '',
  };
}

export function getCurrentServiceTemperament(
  serviceId?: string,
): ServiceTemperamentProfile {
  const resolvedServiceId =
    serviceId?.trim() || process.env.SERVICE_ID?.trim() || 'normal';
  return getServiceTemperament(process.cwd(), resolvedServiceId);
}

export function assignServiceTemperament(args: {
  projectRoot: string;
  serviceId: string;
  temperamentId?: string;
}): ServiceTemperamentProfile {
  const store = readAssignments(args.projectRoot);
  const nextId = normalizeTemperamentId(args.temperamentId);

  if (nextId === 'normal') {
    delete store[args.serviceId];
    writeAssignments(args.projectRoot, store);
    return getServiceTemperament(args.projectRoot, args.serviceId);
  }

  store[args.serviceId] = {
    temperamentId: nextId,
    updatedAt: new Date().toISOString(),
  };
  writeAssignments(args.projectRoot, store);
  return getServiceTemperament(args.projectRoot, args.serviceId);
}

export function upsertTemperamentDefinition(args: {
  projectRoot: string;
  temperamentId?: string;
  name: string;
  prompt: string;
}): TemperamentDefinition {
  const temperamentId = normalizeTemperamentId(args.temperamentId || args.name);
  const definition: TemperamentDefinition = {
    temperamentId,
    name: args.name.trim() || temperamentId,
    prompt: args.prompt.trim(),
    updatedAt: new Date().toISOString(),
    builtin: false,
  };
  const store = readDefinitions(args.projectRoot);
  store[temperamentId] = {
    name: definition.name,
    prompt: definition.prompt,
    updatedAt: definition.updatedAt,
  };
  writeDefinitions(args.projectRoot, store);
  return definition;
}

export function deleteTemperamentDefinition(
  projectRoot: string,
  temperamentId: string,
): void {
  const normalizedId = normalizeTemperamentId(temperamentId);
  if (
    BUILTIN_TEMPERAMENTS.some((entry) => entry.temperamentId === normalizedId)
  ) {
    throw new Error('기본 성향은 삭제할 수 없습니다.');
  }
  const store = readDefinitions(projectRoot);
  delete store[normalizedId];
  writeDefinitions(projectRoot, store);
}

export function applyServiceTemperament(
  prompt: string,
  profile: Pick<ServiceTemperamentProfile, 'temperamentId' | 'prompt'>,
): string {
  const temperamentPrompt = profile.prompt.trim();
  if (!temperamentPrompt) {
    return prompt;
  }
  return [
    '[SERVICE TEMPERAMENT]',
    `Temperament: ${normalizeTemperamentId(profile.temperamentId)}`,
    temperamentPrompt,
    '',
    '[USER / CHANNEL REQUEST]',
    prompt,
  ].join('\n');
}
