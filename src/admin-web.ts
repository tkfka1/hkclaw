import http from 'http';
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { InvalidAdminInputError } from './admin-errors.js';
import { logger } from './logger.js';
import { readAdminMapState, uploadAdminMapAssets } from './admin-map-assets.js';
import {
  renderAdminGamePage,
  renderAdminPhaserBundle,
} from './admin-web-page.js';
import {
  applyTopologyReconcile,
  assignServiceTemperamentConfig,
  deleteServiceConfig,
  deleteOfficeTeamConfig,
  deleteTemperamentConfig,
  readAdminChatHistory,
  readAdminState,
  readServiceLogs,
  runAdminChat,
  runServiceAction,
  toggleChannelAssignment,
  upsertTemperamentConfig,
  upsertOfficeCompanySettingsConfig,
  upsertOfficeRoomLayoutConfig,
  upsertOfficeTeamLayoutConfig,
  upsertOfficeTeamConfig,
  upsertServiceConfig,
} from './service-admin.js';
import { getUnifiedDashboardPreview } from './unified-dashboard.js';

export interface AdminWebServerOptions {
  projectRoot: string;
  host: string;
  port: number;
}

const serviceActionSchema = z.object({
  serviceId: z.string().min(1),
  action: z.enum(['restart', 'start', 'stop']),
});

const serviceDeleteSchema = z.object({
  serviceId: z.string().min(1),
});

const assignmentToggleSchema = z.object({
  jid: z.string().min(1),
  serviceId: z.string().min(1),
  enabled: z.boolean(),
});

const serviceConfigSchema = z.object({
  existingServiceId: z.string().optional(),
  serviceId: z.string().optional(),
  assistantName: z.string().min(1),
  agentType: z.string().min(1),
  role: z.string().optional(),
  teamJid: z.string().optional(),
  statusChannelId: z.string().optional(),
  usageDashboard: z.boolean().optional(),
  voiceChannelIds: z.string().optional(),
  voiceTargetJid: z.string().optional(),
  voiceRouteMap: z.string().optional(),
  voiceGroupFolder: z.string().optional(),
  voiceGroupName: z.string().optional(),
  voiceReconnectDelayMs: z.string().optional(),
  liveVoiceSilenceMs: z.string().optional(),
  liveVoiceMinPcmBytes: z.string().optional(),
  edgeTtsRate: z.string().optional(),
  edgeTtsVoice: z.string().optional(),
  edgeTtsLang: z.string().optional(),
  edgeTtsOutputFormat: z.string().optional(),
  edgeTtsTimeoutMs: z.string().optional(),
  edgeTtsMaxChars: z.string().optional(),
  voiceOutputBitrate: z.string().optional(),
  discordBotToken: z.string().optional(),
  clearDiscordBotToken: z.boolean().optional(),
  anthropicBaseUrl: z.string().optional(),
  anthropicAuthToken: z.string().optional(),
  clearAnthropicAuthToken: z.boolean().optional(),
  claudeCodeOauthToken: z.string().optional(),
  clearClaudeCodeOauthToken: z.boolean().optional(),
  claudeCodeOauthTokens: z.string().optional(),
  clearClaudeCodeOauthTokens: z.boolean().optional(),
  codexAuthJson: z.string().optional(),
  clearCodexAuthJson: z.boolean().optional(),
  openAiApiKey: z.string().optional(),
  clearOpenAiApiKey: z.boolean().optional(),
  groqApiKey: z.string().optional(),
  clearGroqApiKey: z.boolean().optional(),
  groqTranscriptionModel: z.string().optional(),
  openAiTranscriptionModel: z.string().optional(),
  transcriptionLanguage: z.string().optional(),
  codexModel: z.string().optional(),
  codexEffort: z.string().optional(),
  fallbackEnabled: z.string().optional(),
  fallbackProviderName: z.string().optional(),
  fallbackBaseUrl: z.string().optional(),
  fallbackAuthToken: z.string().optional(),
  clearFallbackAuthToken: z.boolean().optional(),
  fallbackModel: z.string().optional(),
  fallbackSmallModel: z.string().optional(),
  fallbackCooldownMs: z.string().optional(),
});

const serviceTemperamentSchema = z.object({
  serviceId: z.string().min(1),
  temperamentId: z.string().optional(),
});

const temperamentDefinitionSchema = z.object({
  temperamentId: z.string().optional(),
  name: z.string().min(1),
  prompt: z.string(),
});

const temperamentDeleteSchema = z.object({
  temperamentId: z.string().min(1),
});

const officeTeamSchema = z.object({
  teamId: z.string().optional(),
  name: z.string().min(1),
  linkedJid: z.string().optional(),
  folder: z.string().optional(),
  requiresMention: z.boolean().optional(),
  color: z.string().optional(),
});

const officeTeamLayoutSchema = z.object({
  teamId: z.string().min(1),
  left: z.number().finite(),
  top: z.number().finite(),
  width: z.number().finite().optional(),
  height: z.number().finite().optional(),
  name: z.string().optional(),
});

const officeRoomLayoutSchema = z.object({
  roomId: z.string().min(1),
  left: z.number().finite(),
  top: z.number().finite(),
  width: z.number().finite().optional(),
  height: z.number().finite().optional(),
  name: z.string().optional(),
});

const officeTeamDeleteSchema = z.object({
  teamId: z.string().min(1),
});

const companySettingsSchema = z.object({
  companyName: z.string().optional(),
  officeTitle: z.string().optional(),
  officeSubtitle: z.string().optional(),
});

const adminChatSchema = z.object({
  teamId: z.string().min(1),
  serviceId: z.string().optional(),
  message: z.string().min(1),
});

const uploadedFileSchema = z.object({
  name: z.string().min(1),
  contentBase64: z.string().min(1),
});

const mapUploadSchema = z.object({
  mapFile: uploadedFileSchema.optional(),
  projectFile: uploadedFileSchema.optional(),
  tilesetFile: uploadedFileSchema.optional(),
});

let adminServer: http.Server | null = null;

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res: http.ServerResponse, html: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

function sendScript(
  res: http.ServerResponse,
  script: string,
  contentType: string = 'application/javascript; charset=utf-8',
): void {
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'public, max-age=3600',
    'content-length': Buffer.byteLength(script),
  });
  res.end(script);
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.svg':
      return 'image/svg+xml; charset=utf-8';
    case '.json':
    case '.tmj':
    case '.tiled-project':
      return 'application/json; charset=utf-8';
    case '.tsx':
      return 'application/xml; charset=utf-8';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

function sendStaticFile(
  res: http.ServerResponse,
  rootDir: string,
  relativePath: string,
): void {
  const decoded = decodeURIComponent(relativePath.replace(/^\/+/, ''));
  const targetPath = path.resolve(rootDir, decoded);
  const allowedRoot = path.resolve(rootDir);
  if (
    !targetPath.startsWith(allowedRoot + path.sep) &&
    targetPath !== allowedRoot
  ) {
    throw new Error('Invalid asset path');
  }

  const body = fs.readFileSync(targetPath);
  res.writeHead(200, {
    'content-type': getContentType(targetPath),
    'cache-control': 'no-store',
    'content-length': body.byteLength,
  });
  res.end(body);
}

async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes = 10 * 1024 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalLength = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalLength += buffer.length;
    if (totalLength > maxBytes) {
      throw new Error('Request body too large');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

function renderAdminPage(): string {
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>HKClaw Control Deck</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap');

      :root {
        --bg: #07131b;
        --bg-soft: #10222b;
        --panel: rgba(10, 25, 33, 0.82);
        --panel-strong: rgba(12, 31, 41, 0.96);
        --line: rgba(155, 205, 216, 0.16);
        --line-strong: rgba(255, 196, 118, 0.28);
        --text: #f6efdf;
        --muted: #97b0b8;
        --accent: #ffba63;
        --accent-2: #51d4c1;
        --danger: #ff7f73;
        --blue: #7ab7ff;
        --shadow: 0 28px 80px rgba(0, 0, 0, 0.28);
        --mono: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
        --sans: "Space Grotesk", "Noto Sans KR", "Apple SD Gothic Neo", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      html, body {
        margin: 0;
        min-height: 100%;
        background:
          radial-gradient(circle at top left, rgba(81, 212, 193, 0.16), transparent 28%),
          radial-gradient(circle at top right, rgba(255, 186, 99, 0.18), transparent 35%),
          linear-gradient(180deg, #07131b 0%, #091923 52%, #061018 100%);
        color: var(--text);
        font-family: var(--sans);
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image:
          linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
        background-size: 32px 32px;
        mask-image: linear-gradient(180deg, rgba(0,0,0,0.2), rgba(0,0,0,0.85));
      }

      a {
        color: inherit;
      }

      code {
        font-family: var(--mono);
        color: var(--accent);
      }

      .shell {
        width: min(1480px, calc(100vw - 32px));
        margin: 24px auto 48px;
      }

      .hero {
        position: relative;
        overflow: hidden;
        padding: 28px;
        border: 1px solid var(--line-strong);
        border-radius: 28px;
        background:
          linear-gradient(135deg, rgba(255, 186, 99, 0.12), transparent 38%),
          linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0)),
          var(--panel);
        box-shadow: var(--shadow);
        backdrop-filter: blur(16px);
      }

      .hero::after {
        content: "";
        position: absolute;
        width: 360px;
        height: 360px;
        right: -120px;
        top: -120px;
        border-radius: 999px;
        background: radial-gradient(circle, rgba(81, 212, 193, 0.32), transparent 68%);
        filter: blur(4px);
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.04);
        color: var(--muted);
        font: 500 12px/1.2 var(--mono);
        text-transform: uppercase;
        letter-spacing: 0.12em;
      }

      h1 {
        margin: 18px 0 10px;
        font-size: clamp(34px, 5vw, 60px);
        line-height: 0.96;
        letter-spacing: -0.04em;
      }

      .hero-copy {
        width: min(760px, 100%);
        color: #d5dfdf;
        font-size: 16px;
        line-height: 1.65;
      }

      .hero-actions, .stat-grid, .service-grid, .control-row {
        display: grid;
        gap: 14px;
      }

      .hero-actions {
        margin-top: 22px;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      }

      .stat-grid {
        margin-top: 20px;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      }

      .stat {
        padding: 16px 18px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.04);
      }

      .stat-label {
        color: var(--muted);
        font: 500 12px/1.2 var(--mono);
        text-transform: uppercase;
        letter-spacing: 0.1em;
      }

      .stat-value {
        margin-top: 10px;
        font-size: 28px;
        font-weight: 700;
      }

      .section {
        margin-top: 22px;
        padding: 22px;
        border-radius: 24px;
        border: 1px solid var(--line);
        background: var(--panel);
        box-shadow: var(--shadow);
        backdrop-filter: blur(16px);
      }

      .section-head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 14px;
        margin-bottom: 18px;
      }

      .section-title {
        margin: 0;
        font-size: 22px;
        letter-spacing: -0.03em;
      }

      .section-copy {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 14px;
        line-height: 1.6;
      }

      .service-grid {
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      }

      .card {
        position: relative;
        padding: 18px;
        border-radius: 22px;
        border: 1px solid var(--line);
        background:
          linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02)),
          var(--panel-strong);
      }

      .card::before {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: linear-gradient(135deg, rgba(255,186,99,0.12), transparent 42%);
        opacity: 0.7;
        pointer-events: none;
      }

      .card > * {
        position: relative;
      }

      .card-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
      }

      .card-title {
        margin: 0;
        font-size: 24px;
        letter-spacing: -0.03em;
      }

      .card-meta {
        margin-top: 8px;
        color: var(--muted);
        font: 500 12px/1.55 var(--mono);
      }

      .pill-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 999px;
        border: 1px solid transparent;
        background: rgba(255, 255, 255, 0.06);
        color: var(--text);
        font: 500 12px/1.2 var(--mono);
      }

      .pill.running {
        border-color: rgba(81, 212, 193, 0.28);
        color: var(--accent-2);
        background: rgba(81, 212, 193, 0.08);
      }

      .pill.stopped {
        border-color: rgba(255, 127, 115, 0.3);
        color: var(--danger);
        background: rgba(255, 127, 115, 0.08);
      }

      .pill.role-dashboard { background: rgba(122, 183, 255, 0.12); color: var(--blue); }
      .pill.role-assistant { background: rgba(255, 186, 99, 0.12); color: var(--accent); }
      .pill.role-chat { background: rgba(255, 255, 255, 0.08); color: #f7f3ea; }

      .form-grid {
        display: grid;
        gap: 12px;
        margin-top: 18px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .field.wide {
        grid-column: 1 / -1;
      }

      .field label {
        color: var(--muted);
        font: 500 11px/1.2 var(--mono);
        text-transform: uppercase;
        letter-spacing: 0.1em;
      }

      input, select {
        width: 100%;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.1);
        background: rgba(6, 15, 22, 0.66);
        color: var(--text);
        font: 500 14px/1.2 var(--sans);
      }

      input::placeholder {
        color: rgba(151, 176, 184, 0.72);
      }

      .checkbox {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.1);
        background: rgba(6, 15, 22, 0.66);
        color: var(--text);
        font-size: 14px;
      }

      .checkbox input {
        width: 18px;
        height: 18px;
        margin: 0;
      }

      button {
        border: 0;
        border-radius: 14px;
        padding: 12px 15px;
        cursor: pointer;
        color: #081118;
        background: linear-gradient(135deg, var(--accent), #ffc989);
        font: 700 13px/1 var(--mono);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        transition: transform 120ms ease, opacity 120ms ease, box-shadow 120ms ease;
        box-shadow: 0 12px 28px rgba(255, 186, 99, 0.18);
      }

      button:hover {
        transform: translateY(-1px);
      }

      button.secondary {
        color: var(--text);
        background: rgba(255,255,255,0.07);
        box-shadow: none;
      }

      button.ghost {
        color: var(--muted);
        background: transparent;
        border: 1px solid rgba(255,255,255,0.12);
        box-shadow: none;
      }

      button.danger {
        color: #1a0907;
        background: linear-gradient(135deg, #ff8e7f, #ffb3a8);
        box-shadow: 0 12px 28px rgba(255, 127, 115, 0.16);
      }

      button:disabled {
        opacity: 0.55;
        cursor: wait;
        transform: none;
      }

      .control-row {
        margin-top: 18px;
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }

      .channel-tools {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 16px;
      }

      .search {
        min-width: min(380px, 100%);
      }

      .table-wrap {
        overflow: auto;
        border-radius: 18px;
        border: 1px solid var(--line);
      }

      table {
        width: 100%;
        min-width: 880px;
        border-collapse: collapse;
        background: rgba(3, 9, 14, 0.48);
      }

      thead th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: rgba(7, 20, 28, 0.96);
        color: var(--muted);
        font: 600 12px/1.2 var(--mono);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      th, td {
        padding: 14px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        text-align: left;
        vertical-align: top;
      }

      tbody tr:hover {
        background: rgba(255,255,255,0.03);
      }

      .channel-name {
        font-weight: 700;
      }

      .channel-meta {
        margin-top: 6px;
        color: var(--muted);
        font: 500 12px/1.5 var(--mono);
      }

      .assignment-cell {
        min-width: 160px;
      }

      .assignment-card {
        display: grid;
        gap: 10px;
      }

      .assignment-detail {
        color: var(--muted);
        font: 500 11px/1.45 var(--mono);
      }

      .mapping {
        padding: 10px 12px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.03);
      }

      .mapping.active {
        border-color: rgba(81, 212, 193, 0.26);
        background: rgba(81, 212, 193, 0.08);
      }

      .company-floor {
        position: relative;
        overflow: hidden;
        min-height: 760px;
        border-radius: 28px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background:
          linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0)),
          radial-gradient(circle at top left, rgba(81, 212, 193, 0.10), transparent 25%),
          linear-gradient(180deg, #132733 0%, #10222b 46%, #0d1920 100%);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
      }

      .company-floor::before {
        content: "";
        position: absolute;
        inset: 0;
        background:
          linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
        background-size: 34px 34px;
        opacity: 0.55;
        pointer-events: none;
      }

      .company-floor::after {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        bottom: 24%;
        height: 1px;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,0.16), transparent);
        pointer-events: none;
      }

      .office-layer {
        position: absolute;
        inset: 0;
      }

      .office-zone {
        position: absolute;
        padding: 14px;
        border-radius: 24px;
        border: 1px solid rgba(255,255,255,0.08);
        background:
          linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02)),
          rgba(6, 17, 24, 0.62);
        box-shadow:
          0 16px 32px rgba(0,0,0,0.18),
          inset 0 1px 0 rgba(255,255,255,0.04);
      }

      .office-zone.team-zone {
        background:
          linear-gradient(135deg, rgba(255, 186, 99, 0.12), transparent 45%),
          rgba(6, 17, 24, 0.68);
      }

      .office-zone.lounge-zone {
        background:
          linear-gradient(135deg, rgba(81, 212, 193, 0.12), transparent 45%),
          rgba(6, 17, 24, 0.68);
      }

      .office-zone.hiring-zone {
        background:
          linear-gradient(135deg, rgba(122, 183, 255, 0.16), transparent 45%),
          rgba(6, 17, 24, 0.68);
      }

      .office-zone.offline-zone {
        background:
          linear-gradient(135deg, rgba(255, 127, 115, 0.14), transparent 45%),
          rgba(6, 17, 24, 0.68);
      }

      .zone-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
      }

      .zone-title {
        margin: 0;
        font-size: 16px;
        letter-spacing: -0.03em;
      }

      .zone-copy {
        margin-top: 6px;
        color: var(--muted);
        font: 500 11px/1.4 var(--mono);
      }

      .zone-badge {
        padding: 6px 8px;
        border-radius: 999px;
        background: rgba(255,255,255,0.08);
        color: var(--muted);
        font: 600 10px/1 var(--mono);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .desk-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        margin-top: 18px;
      }

      .desk {
        position: relative;
        min-height: 74px;
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,0.06);
        background:
          linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02)),
          rgba(255,255,255,0.02);
      }

      .desk::before {
        content: "";
        position: absolute;
        left: 12px;
        right: 12px;
        top: 10px;
        height: 12px;
        border-radius: 8px;
        background: rgba(122, 183, 255, 0.12);
        box-shadow: inset 0 0 0 1px rgba(122, 183, 255, 0.12);
      }

      .desk::after {
        content: "";
        position: absolute;
        left: 22px;
        right: 22px;
        bottom: 10px;
        height: 10px;
        border-radius: 999px;
        background: rgba(255,255,255,0.06);
      }

      .team-chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 14px;
      }

      .team-chip {
        padding: 6px 8px;
        border-radius: 999px;
        background: rgba(255,255,255,0.06);
        color: var(--muted);
        font: 600 10px/1 var(--mono);
      }

      .office-worker {
        position: absolute;
        width: 92px;
        margin-left: -46px;
        margin-top: -34px;
        transition:
          left 1.6s cubic-bezier(0.2, 0.75, 0.24, 1),
          top 1.6s cubic-bezier(0.2, 0.75, 0.24, 1);
        pointer-events: none;
        z-index: 8;
      }

      .office-worker[data-presence="offline"] {
        opacity: 0.65;
        filter: saturate(0.45);
      }

      .worker-bubble {
        margin: 0 auto 6px;
        width: fit-content;
        max-width: 92px;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(6, 17, 24, 0.92);
        border: 1px solid rgba(255,255,255,0.08);
        color: var(--text);
        font: 600 10px/1.2 var(--mono);
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .worker-sprite {
        position: relative;
        width: 48px;
        height: 58px;
        margin: 0 auto;
        animation: worker-bounce 1.8s ease-in-out infinite;
      }

      .worker-sprite::before {
        content: "";
        position: absolute;
        left: 50%;
        top: 0;
        width: 18px;
        height: 18px;
        margin-left: -9px;
        border-radius: 50%;
        background: #f4d4b6;
        box-shadow: inset 0 -2px 0 rgba(0,0,0,0.08);
      }

      .worker-sprite::after {
        content: "";
        position: absolute;
        left: 50%;
        top: 16px;
        width: 32px;
        height: 28px;
        margin-left: -16px;
        border-radius: 12px 12px 10px 10px;
        background: var(--worker-accent, var(--accent));
        box-shadow:
          inset 0 -4px 0 rgba(0,0,0,0.12),
          0 12px 0 -7px rgba(255,255,255,0.08);
      }

      .worker-feet {
        position: absolute;
        left: 50%;
        bottom: 0;
        width: 28px;
        height: 16px;
        margin-left: -14px;
      }

      .worker-feet::before,
      .worker-feet::after {
        content: "";
        position: absolute;
        bottom: 0;
        width: 9px;
        height: 14px;
        border-radius: 999px;
        background: #22323d;
        transform-origin: top center;
      }

      .worker-feet::before {
        left: 4px;
        animation: leg-swing 0.8s ease-in-out infinite;
      }

      .worker-feet::after {
        right: 4px;
        animation: leg-swing 0.8s ease-in-out infinite reverse;
      }

      .office-worker[data-presence="resting"] .worker-feet::before,
      .office-worker[data-presence="resting"] .worker-feet::after,
      .office-worker[data-presence="monitoring"] .worker-feet::before,
      .office-worker[data-presence="monitoring"] .worker-feet::after {
        animation-duration: 1.4s;
        transform: rotate(4deg);
      }

      .office-worker[data-presence="working"] .worker-bubble {
        border-color: rgba(255, 186, 99, 0.25);
        color: var(--accent);
      }

      .office-worker[data-presence="resting"] .worker-bubble {
        border-color: rgba(81, 212, 193, 0.22);
        color: var(--accent-2);
      }

      .office-worker[data-presence="monitoring"] .worker-bubble {
        border-color: rgba(122, 183, 255, 0.22);
        color: var(--blue);
      }

      .office-worker[data-theme="claude"] { --worker-accent: #ffba63; }
      .office-worker[data-theme="codex"] { --worker-accent: #51d4c1; }
      .office-worker[data-theme="dashboard"] { --worker-accent: #7ab7ff; }

      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 18px;
      }

      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 999px;
        background: rgba(255,255,255,0.05);
        color: var(--muted);
        font: 500 11px/1 var(--mono);
      }

      .legend-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
      }

      .scene-caption {
        margin-top: 14px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.6;
      }

      @keyframes worker-bounce {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-3px); }
      }

      @keyframes leg-swing {
        0%, 100% { transform: rotate(10deg); }
        50% { transform: rotate(-10deg); }
      }

      .toast {
        position: fixed;
        right: 18px;
        bottom: 18px;
        max-width: 420px;
        padding: 14px 16px;
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(10, 26, 34, 0.96);
        box-shadow: var(--shadow);
        color: var(--text);
        opacity: 0;
        transform: translateY(10px);
        pointer-events: none;
        transition: opacity 180ms ease, transform 180ms ease;
      }

      .toast.show {
        opacity: 1;
        transform: translateY(0);
      }

      .empty {
        padding: 32px;
        text-align: center;
        color: var(--muted);
      }

      @media (max-width: 980px) {
        .control-row, .form-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div id="app" class="shell"></div>
    <div id="toast" class="toast"></div>
    <script type="module">
      const app = document.getElementById('app');
      const toast = document.getElementById('toast');
      const state = {
        data: null,
        search: '',
        busy: false,
        workerPositions: {},
        pollStarted: false,
      };

      function escapeSelector(value) {
        return String(value ?? '')
          .replaceAll('\\\\', '\\\\\\\\')
          .replaceAll('"', '\\\\"');
      }

      function escapeHtml(value) {
        return String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function formatTime(value) {
        if (!value) return '기록 없음';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString('ko-KR', { hour12: false });
      }

      function compactChannelName(name) {
        return String(name || '')
          .replace(/^.+?#/, '#')
          .replace(/^hankyo\s+/i, '')
          .trim();
      }

      function getServiceTheme(service) {
        if (service.role === 'dashboard') return 'dashboard';
        if (service.agentType === 'codex') return 'codex';
        return 'claude';
      }

      function getPresenceLabel(service) {
        switch (service.presence) {
          case 'working':
            return 'working';
          case 'monitoring':
            return 'monitor';
          case 'offline':
            return 'offline';
          default:
            return 'rest';
        }
      }

      function toastMessage(message) {
        toast.textContent = message;
        toast.classList.add('show');
        window.clearTimeout(toast._timer);
        toast._timer = window.setTimeout(() => {
          toast.classList.remove('show');
        }, 3200);
      }

      async function api(path, body) {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || 'Request failed');
        }
        return payload;
      }

      async function loadState() {
        const response = await fetch('/api/admin/state', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error('Failed to load admin state');
        }
        state.data = await response.json();
        render();
      }

      function captureViewState() {
        const active = document.activeElement;
        const base = {
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          activeField: null,
          activeServiceId: null,
          activeSelectionStart: null,
          activeSelectionEnd: null,
        };

        if (!active || !(active instanceof HTMLElement)) {
          return base;
        }

        const field = active.getAttribute('data-field');
        if (!field) {
          return base;
        }

        const serviceCard = active.closest('[data-service-card]');
        return {
          ...base,
          activeField: field,
          activeServiceId:
            serviceCard?.getAttribute('data-service-card') || '__create__',
          activeSelectionStart:
            'selectionStart' in active ? active.selectionStart : null,
          activeSelectionEnd:
            'selectionEnd' in active ? active.selectionEnd : null,
        };
      }

      function restoreViewState(viewState) {
        window.requestAnimationFrame(() => {
          window.scrollTo(viewState.scrollX, viewState.scrollY);

          if (!viewState.activeField || !viewState.activeServiceId) {
            return;
          }

          const rootSelector =
            viewState.activeServiceId === '__create__'
              ? '[data-service-create]'
              : '[data-service-card="' +
                escapeSelector(viewState.activeServiceId) +
                '"]';
          const selector =
            rootSelector +
            ' [data-field="' +
            escapeSelector(viewState.activeField) +
            '"]';
          const nextActive = app.querySelector(selector);
          if (!(nextActive instanceof HTMLElement)) {
            return;
          }

          nextActive.focus({ preventScroll: true });
          if (
            'setSelectionRange' in nextActive &&
            typeof viewState.activeSelectionStart === 'number' &&
            typeof viewState.activeSelectionEnd === 'number'
          ) {
            nextActive.setSelectionRange(
              viewState.activeSelectionStart,
              viewState.activeSelectionEnd,
            );
          }
        });
      }

      function serviceCard(service) {
        const runtimeClass = service.runtime.running ? 'running' : 'stopped';
        const runtimeLabel = service.runtime.running
          ? service.runtime.subState || 'running'
          : service.runtime.activeState || 'inactive';
        return \`
          <article class="card" data-service-card="\${escapeHtml(service.serviceId)}">
            <div class="card-head">
              <div>
                <h3 class="card-title">\${escapeHtml(service.assistantName)}</h3>
                <div class="card-meta">
                  <div>\${escapeHtml(service.serviceName)} · \${escapeHtml(service.serviceId)}</div>
                  <div>\${escapeHtml(service.envPath)}</div>
                </div>
              </div>
              <div class="pill-row">
                <span class="pill \${runtimeClass}">\${escapeHtml(runtimeLabel)}</span>
                <span class="pill role-\${escapeHtml(service.role)}">\${escapeHtml(service.role)}</span>
                <span class="pill">\${escapeHtml(service.agentType)}</span>
                <span class="pill">\${escapeHtml(getPresenceLabel(service))}</span>
              </div>
            </div>
            <div class="form-grid">
              <div class="field">
                <label>Assistant</label>
                <input data-field="assistantName" value="\${escapeHtml(service.config.assistantName)}" />
              </div>
              <div class="field">
                <label>Service Id</label>
                <input value="\${escapeHtml(service.serviceId)}" disabled />
              </div>
              <div class="field">
                <label>Agent Type</label>
                <select data-field="agentType">
                  <option value="claude-code" \${service.config.agentType === 'claude-code' ? 'selected' : ''}>claude-code</option>
                  <option value="codex" \${service.config.agentType === 'codex' ? 'selected' : ''}>codex</option>
                </select>
              </div>
              <div class="field">
                <label>Role</label>
                <select data-field="role">
                  <option value="assistant" \${service.config.role === 'assistant' ? 'selected' : ''}>assistant</option>
                  <option value="chat" \${service.config.role === 'chat' ? 'selected' : ''}>chat</option>
                  <option value="dashboard" \${service.config.role === 'dashboard' ? 'selected' : ''}>dashboard</option>
                </select>
              </div>
              <div class="field">
                <label>Status Channel</label>
                <input data-field="statusChannelId" value="\${escapeHtml(service.config.statusChannelId)}" placeholder="Discord status channel ID" />
              </div>
              <div class="field">
                <label>Voice Target JID</label>
                <input data-field="voiceTargetJid" value="\${escapeHtml(service.config.voiceTargetJid)}" placeholder="dc:..." />
              </div>
              <div class="field wide">
                <label>Voice Channel Ids</label>
                <input data-field="voiceChannelIds" value="\${escapeHtml(service.config.voiceChannelIds)}" placeholder="123,456" />
              </div>
              <div class="field wide">
                <label>Voice Route Map</label>
                <input data-field="voiceRouteMap" value="\${escapeHtml(service.config.voiceRouteMap)}" placeholder="voiceId=textJid,..." />
              </div>
              <div class="field">
                <label>Voice Session Folder</label>
                <input data-field="voiceGroupFolder" value="\${escapeHtml(service.config.voiceGroupFolder)}" placeholder="optional" />
              </div>
              <div class="field">
                <label>Voice Session Name</label>
                <input data-field="voiceGroupName" value="\${escapeHtml(service.config.voiceGroupName)}" placeholder="optional" />
              </div>
              <div class="field wide">
                <label>Discord Token</label>
                <input data-field="discordBotToken" type="password" placeholder="\${service.config.botTokenConfigured ? 'configured - leave blank to keep' : 'set bot token'}" />
              </div>
              <div class="field wide">
                <label>Usage Dashboard</label>
                <label class="checkbox">
                  <input data-field="usageDashboard" type="checkbox" \${service.config.usageDashboard ? 'checked' : ''} />
                  Dashboard usage rendering 활성화
                </label>
              </div>
            </div>
            <div class="control-row">
              <button data-service-save="\${escapeHtml(service.serviceId)}">Update + Reconcile</button>
              <button class="secondary" data-service-op="restart" data-service-id="\${escapeHtml(service.serviceId)}">Restart</button>
              <button class="ghost" data-service-op="start" data-service-id="\${escapeHtml(service.serviceId)}">Start</button>
              <button class="danger" data-service-op="stop" data-service-id="\${escapeHtml(service.serviceId)}">Stop</button>
            </div>
          </article>
        \`;
      }

      function createServiceCard() {
        return \`
          <article class="card" data-service-create>
            <div class="card-head">
              <div>
                <h3 class="card-title">New Service</h3>
                <div class="card-meta">
                  <div>.env.agent.&lt;service_id&gt; 생성 후 서비스 유닛을 다시 맞춥니다.</div>
                </div>
              </div>
              <div class="pill-row">
                <span class="pill role-chat">overlay</span>
              </div>
            </div>
            <div class="form-grid">
              <div class="field">
                <label>Service Id</label>
                <input data-field="serviceId" placeholder="worker-1, codex-1, dashboard" />
              </div>
              <div class="field">
                <label>Assistant</label>
                <input data-field="assistantName" placeholder="새 직원 이름" />
              </div>
              <div class="field">
                <label>Agent Type</label>
                <select data-field="agentType">
                  <option value="claude-code">claude-code</option>
                  <option value="codex">codex</option>
                </select>
              </div>
              <div class="field">
                <label>Role</label>
                <select data-field="role">
                  <option value="chat">chat</option>
                  <option value="assistant">assistant</option>
                  <option value="dashboard">dashboard</option>
                </select>
              </div>
              <div class="field">
                <label>Status Channel</label>
                <input data-field="statusChannelId" placeholder="optional" />
              </div>
              <div class="field">
                <label>Voice Target JID</label>
                <input data-field="voiceTargetJid" placeholder="dc:..." />
              </div>
              <div class="field wide">
                <label>Voice Channel Ids</label>
                <input data-field="voiceChannelIds" placeholder="123,456" />
              </div>
              <div class="field wide">
                <label>Discord Token</label>
                <input data-field="discordBotToken" type="password" placeholder="bot token" />
              </div>
              <div class="field wide">
                <label>Usage Dashboard</label>
                <label class="checkbox">
                  <input data-field="usageDashboard" type="checkbox" />
                  Usage dashboard 켜기
                </label>
              </div>
            </div>
            <div class="control-row">
              <button data-service-create-submit>Hire + Reconcile</button>
              <button class="ghost" type="button" disabled>overlay env</button>
              <button class="ghost" type="button" disabled>systemd unit</button>
              <button class="ghost" type="button" disabled>auto start</button>
            </div>
          </article>
        \`;
      }

      function assignmentCell(channel, service) {
        const assignment = channel.assignments.find((item) => item.serviceId === service.serviceId);
        const active = Boolean(assignment);
        const isStatusAssignment = assignment?.kind === 'status-dashboard';
        const buttonLabel = isStatusAssignment
          ? 'Status Channel'
          : active
            ? 'Mapped'
            : 'Assign';
        const detail = !active
          ? '매핑 없음'
          : isStatusAssignment
            ? 'dashboard render target<br />STATUS_CHANNEL_ID 기반'
            : 'folder=' + escapeHtml(assignment.folder) + '<br />trigger=' + (assignment.requiresTrigger ? 'required' : 'free') + '<br />main=' + (assignment.isMain ? 'yes' : 'no');
        return \`
          <td class="assignment-cell">
            <div class="mapping \${active ? 'active' : ''}">
              <div class="assignment-card">
                <button
                  class="\${active ? 'secondary' : 'ghost'}"
                  \${isStatusAssignment ? 'disabled' : 'data-assignment-toggle data-service-id="' + escapeHtml(service.serviceId) + '" data-jid="' + escapeHtml(channel.jid) + '" data-enabled="' + (active ? 'false' : 'true') + '"'}
                >\${buttonLabel}</button>
                <div class="assignment-detail">
                  \${detail}
                </div>
              </div>
            </div>
          </td>
        \`;
      }

      function buildOfficeModel(data) {
        const teams = data.channels.filter(
          (channel) =>
            channel.assignments.length > 0 ||
            data.services.some((service) => service.currentJid === channel.jid),
        );
        const visibleTeams = teams.slice(0, 8);
        const cols = visibleTeams.length > 4 ? 3 : 2;
        const zoneWidth = cols === 3 ? 20 : 27;
        const zoneHeight = 21;
        const baseX = 30;
        const gapX = cols === 3 ? 4 : 6;
        const baseY = 11;
        const gapY = 5;

        const zones = [
          {
            key: 'hiring',
            label: 'Hiring Desk',
            subtitle: 'new bots = recruitment',
            x: 6,
            y: 11,
            w: 18,
            h: 20,
            kind: 'hiring-zone',
            badges: ['hr'],
          },
          {
            key: 'lounge',
            label: 'Rest Lounge',
            subtitle: 'idle bots recharge here',
            x: 6,
            y: 64,
            w: 24,
            h: 22,
            kind: 'lounge-zone',
            badges: ['rest'],
          },
          {
            key: 'offline',
            label: 'Offsite',
            subtitle: 'stopped services wait here',
            x: 74,
            y: 64,
            w: 20,
            h: 22,
            kind: 'offline-zone',
            badges: ['paused'],
          },
        ];

        visibleTeams.forEach((team, index) => {
          const row = Math.floor(index / cols);
          const col = index % cols;
          zones.push({
            key: team.jid,
            label: compactChannelName(team.name) || team.jid,
            subtitle: team.assignments.length > 0
              ? team.assignments.map((assignment) => assignment.serviceId).join(' / ')
              : 'unassigned',
            x: baseX + col * (zoneWidth + gapX),
            y: baseY + row * (zoneHeight + gapY),
            w: zoneWidth,
            h: zoneHeight,
            kind: 'team-zone',
            badges: team.assignments.map((assignment) =>
              assignment.kind === 'status-dashboard'
                ? 'status wall'
                : assignment.serviceId,
            ),
          });
        });

        const zoneByKey = Object.fromEntries(zones.map((zone) => [zone.key, zone]));
        const seatOffsets = [
          { x: 22, y: 60 },
          { x: 50, y: 60 },
          { x: 76, y: 60 },
          { x: 34, y: 78 },
          { x: 64, y: 78 },
        ];
        const seatUsage = {};
        const workers = data.services.map((service, index) => {
          const targetKey =
            service.presence === 'offline'
              ? 'offline'
              : service.currentJid && zoneByKey[service.currentJid]
                ? service.currentJid
                : 'lounge';
          const zone = zoneByKey[targetKey] || zoneByKey.lounge;
          const slotIndex = seatUsage[targetKey] || 0;
          seatUsage[targetKey] = slotIndex + 1;
          const slot = seatOffsets[slotIndex % seatOffsets.length];
          const left = zone.x + (zone.w * slot.x) / 100;
          const top = zone.y + (zone.h * slot.y) / 100;
          return {
            ...service,
            theme: getServiceTheme(service),
            statusLabel: getPresenceLabel(service),
            targetLeft: left,
            targetTop: top,
            zoneLabel: zone.label,
            slotIndex,
          };
        });

        return { zones, workers };
      }

      function renderOfficeFloor(data) {
        const office = buildOfficeModel(data);
        const zoneMarkup = office.zones
          .map((zone) => \`
            <div
              class="office-zone \${zone.kind}"
              style="left:\${zone.x}%; top:\${zone.y}%; width:\${zone.w}%; height:\${zone.h}%;"
            >
              <div class="zone-head">
                <div>
                  <h3 class="zone-title">\${escapeHtml(zone.label)}</h3>
                  <div class="zone-copy">\${escapeHtml(zone.subtitle)}</div>
                </div>
                <span class="zone-badge">\${escapeHtml(zone.kind.replace('-zone', ''))}</span>
              </div>
              <div class="desk-grid">
                <div class="desk"></div>
                <div class="desk"></div>
                <div class="desk"></div>
                <div class="desk"></div>
              </div>
              <div class="team-chip-row">
                \${zone.badges.slice(0, 4).map((badge) => '<span class="team-chip">' + escapeHtml(badge) + '</span>').join('')}
              </div>
            </div>
          \`)
          .join('');

        const workerMarkup = office.workers
          .map((worker) => {
            const previous = state.workerPositions[worker.serviceId] || {
              left: 15,
              top: 23 + worker.slotIndex * 6,
            };
            return \`
              <div
                class="office-worker"
                data-worker="\${escapeHtml(worker.serviceId)}"
                data-presence="\${escapeHtml(worker.presence)}"
                data-theme="\${escapeHtml(worker.theme)}"
                data-target-left="\${worker.targetLeft}"
                data-target-top="\${worker.targetTop}"
                style="left:\${previous.left}%; top:\${previous.top}%;"
              >
                <div class="worker-bubble">\${escapeHtml(worker.assistantName)} · \${escapeHtml(worker.statusLabel)}</div>
                <div class="worker-sprite">
                  <div class="worker-feet"></div>
                </div>
              </div>
            \`;
          })
          .join('');

        return \`
          <section class="section">
            <div class="section-head">
              <div>
                <h2 class="section-title">HKClaw Office</h2>
                <p class="section-copy">봇은 직원처럼 채용되고, 채널은 팀처럼 배정됩니다. 일하는 중이면 해당 팀 자리로 이동하고, 유휴면 라운지에서 쉽니다.</p>
              </div>
            </div>
            <div class="company-floor">
              <div class="office-layer">\${zoneMarkup}</div>
              <div class="office-layer">\${workerMarkup}</div>
            </div>
            <div class="legend">
              <span class="legend-item"><span class="legend-dot" style="background:#ffba63"></span>Claude worker</span>
              <span class="legend-item"><span class="legend-dot" style="background:#51d4c1"></span>Codex worker</span>
              <span class="legend-item"><span class="legend-dot" style="background:#7ab7ff"></span>Dashboard / ops</span>
            </div>
            <p class="scene-caption"><code>채용</code>은 새 서비스 추가, <code>팀 배정</code>은 채널 매핑, <code>근무 중</code>은 현재 활성 룸 스냅샷 기준입니다. 대시보드 역할은 상태 월을 모니터링합니다.</p>
          </section>
        \`;
      }

      function animateOfficeWorkers() {
        app.querySelectorAll('[data-worker]').forEach((worker) => {
          const targetLeft = Number(worker.dataset.targetLeft || '0');
          const targetTop = Number(worker.dataset.targetTop || '0');
          const serviceId = worker.dataset.worker;
          requestAnimationFrame(() => {
            worker.style.left = targetLeft + '%';
            worker.style.top = targetTop + '%';
          });
          state.workerPositions[serviceId] = {
            left: targetLeft,
            top: targetTop,
          };
        });
      }

      function render() {
        const data = state.data;
        const viewState = captureViewState();
        if (!data) {
          app.innerHTML = '<div class="empty">Loading…</div>';
          return;
        }

        const filteredChannels = data.channels.filter((channel) => {
          const search = state.search.trim().toLowerCase();
          if (!search) return true;
          return (
            channel.name.toLowerCase().includes(search) ||
            channel.jid.toLowerCase().includes(search)
          );
        });

        const mappedChannels = data.channels.filter((channel) => channel.assignments.length > 0).length;
        const totalRooms = data.services.reduce((count, service) => count + service.snapshot.roomCount, 0);
        const workingBots = data.services.filter((service) => service.presence === 'working').length;
        const restingBots = data.services.filter((service) => service.presence === 'resting').length;

        app.innerHTML = \`
          <header class="hero">
            <div class="eyebrow">HKClaw Holdings / company sim</div>
            <h1>봇은 직원, 채널은 팀, 대시보드는 회사 건물입니다.</h1>
            <p class="hero-copy">
              HKClaw 운영 콘솔을 게임처럼 보이게 바꿨습니다. 새 봇을 추가하면 채용되고, 팀에 배정되면 해당 채널 자리에 앉습니다.
              실제 설정 변경, 재시작, 팀 배정은 그대로 동작하고, 위 오피스 씬은 현재 서비스 스냅샷에 맞춰 직원들이 이동하는 형태로 보여줍니다.
            </p>
            <div class="hero-actions">
              <button data-global-action="refresh">Roll Call</button>
              <button class="secondary" data-global-action="reconcile">Rebuild Org</button>
              <button class="ghost" disabled>\${escapeHtml(location.host)}</button>
            </div>
            <div class="stat-grid">
              <div class="stat">
                <div class="stat-label">Employees</div>
                <div class="stat-value">\${data.services.length}</div>
              </div>
              <div class="stat">
                <div class="stat-label">Teams</div>
                <div class="stat-value">\${mappedChannels}</div>
              </div>
              <div class="stat">
                <div class="stat-label">Working</div>
                <div class="stat-value">\${workingBots}</div>
              </div>
              <div class="stat">
                <div class="stat-label">Resting</div>
                <div class="stat-value">\${restingBots}</div>
              </div>
              <div class="stat">
                <div class="stat-label">Updated</div>
                <div class="stat-value" style="font-size:18px">\${escapeHtml(formatTime(data.generatedAt))}</div>
              </div>
            </div>
          </header>

          \${renderOfficeFloor(data)}

          <section class="section">
            <div class="section-head">
              <div>
                <h2 class="section-title">Hiring Board</h2>
                <p class="section-copy">직원 채용과 인사 이동은 여기서 처리합니다. 실제로는 서비스 env 오버레이와 유닛 재구성을 만집니다.</p>
              </div>
            </div>
            <div class="service-grid">
              \${data.services.map(serviceCard).join('')}
              \${createServiceCard()}
            </div>
          </section>

          <section class="section">
            <div class="section-head">
              <div>
                <h2 class="section-title">Team Chart</h2>
                <p class="section-copy">어떤 팀에 어떤 직원이 배정됐는지 확인하고 바꿉니다. 상태 월 채널은 읽기 전용 매핑으로 표시됩니다.</p>
              </div>
            </div>
            <div class="channel-tools">
              <input class="search" data-channel-search placeholder="팀 이름이나 JID 검색" value="\${escapeHtml(state.search)}" />
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Team</th>
                    \${data.services.map((service) => '<th>' + escapeHtml(service.serviceId) + '</th>').join('')}
                  </tr>
                </thead>
                <tbody>
                  \${filteredChannels.length === 0
                    ? '<tr><td class="empty" colspan="' + String(data.services.length + 1) + '">매칭되는 채널이 없습니다.</td></tr>'
                    : filteredChannels.map((channel) => '<tr><td><div class="channel-name">' + escapeHtml(channel.name) + '</div><div class="channel-meta">' + escapeHtml(channel.jid) + '<br />' + escapeHtml(formatTime(channel.lastMessageTime)) + '</div></td>' + data.services.map((service) => assignmentCell(channel, service)).join('') + '</tr>').join('')}
                </tbody>
              </table>
            </div>
          </section>
        \`;

        bindHandlers();
        animateOfficeWorkers();
        restoreViewState(viewState);
      }

      function readCardFields(card) {
        return {
          assistantName: card.querySelector('[data-field="assistantName"]').value,
          agentType: card.querySelector('[data-field="agentType"]').value,
          role: card.querySelector('[data-field="role"]').value,
          statusChannelId: card.querySelector('[data-field="statusChannelId"]').value,
          voiceChannelIds: card.querySelector('[data-field="voiceChannelIds"]')?.value || '',
          voiceTargetJid: card.querySelector('[data-field="voiceTargetJid"]')?.value || '',
          voiceRouteMap: card.querySelector('[data-field="voiceRouteMap"]')?.value || '',
          voiceGroupFolder: card.querySelector('[data-field="voiceGroupFolder"]')?.value || '',
          voiceGroupName: card.querySelector('[data-field="voiceGroupName"]')?.value || '',
          discordBotToken: card.querySelector('[data-field="discordBotToken"]')?.value || '',
          usageDashboard: Boolean(card.querySelector('[data-field="usageDashboard"]')?.checked),
        };
      }

      async function handleClick(event) {
        const target = event.target.closest('button');
        if (!target) return;

        try {
          if (target.dataset.globalAction === 'refresh') {
            await loadState();
            toastMessage('상태를 새로 읽었습니다.');
            return;
          }

          if (target.dataset.globalAction === 'reconcile') {
            target.disabled = true;
            await api('/api/admin/topology/reconcile');
            toastMessage('서비스 재구성을 적용했습니다.');
            await loadState();
            return;
          }

          if (target.dataset.serviceSave) {
            const card = target.closest('[data-service-card]');
            const payload = {
              existingServiceId: target.dataset.serviceSave,
              ...readCardFields(card),
            };
            target.disabled = true;
            await api('/api/admin/services/upsert', payload);
            toastMessage('설정을 저장했고 서비스 구성을 적용했습니다.');
            await loadState();
            return;
          }

          if (target.dataset.serviceOp) {
            target.disabled = true;
            const payload = {
              serviceId: target.dataset.serviceId,
              action: target.dataset.serviceOp,
            };
            const result = await api('/api/admin/services/action', payload);
            toastMessage(
              result.scheduled
                ? '현재 대시보드 서비스 액션을 예약했습니다.'
                : '서비스 액션을 실행했습니다.',
            );
            window.setTimeout(() => void loadState().catch(() => {}), 2500);
            return;
          }

          if (target.dataset.assignmentToggle !== undefined) {
            target.disabled = true;
            await api('/api/admin/assignments/toggle', {
              jid: target.dataset.jid,
              serviceId: target.dataset.serviceId,
              enabled: target.dataset.enabled === 'true',
            });
            toastMessage('채널 매핑을 변경했고 대상 서비스를 재시작했습니다.');
            window.setTimeout(() => void loadState().catch(() => {}), 2500);
            return;
          }

          if (target.dataset.serviceCreateSubmit !== undefined) {
            const card = target.closest('[data-service-create]');
            const payload = {
              serviceId: card.querySelector('[data-field="serviceId"]').value,
              ...readCardFields(card),
            };
            target.disabled = true;
            await api('/api/admin/services/upsert', payload);
            toastMessage('새 서비스를 만들고 바로 적용했습니다.');
            await loadState();
          }
        } catch (error) {
          toastMessage(error.message || '요청 처리에 실패했습니다.');
        } finally {
          window.setTimeout(() => {
            document.querySelectorAll('button:disabled').forEach((button) => {
              button.disabled = false;
            });
          }, 400);
        }
      }

      function bindHandlers() {
        app.querySelectorAll('[data-channel-search]').forEach((input) => {
          input.addEventListener('input', (event) => {
            state.search = event.target.value;
            render();
          });
        });
      }

      app.addEventListener('click', handleClick);

      if (!state.pollStarted) {
        state.pollStarted = true;
        window.setInterval(() => {
          const activeTag = document.activeElement?.tagName || '';
          if (activeTag === 'INPUT' || activeTag === 'SELECT' || activeTag === 'TEXTAREA') {
            return;
          }
          void loadState().catch(() => {});
        }, 8000);
      }

      loadState().catch((error) => {
        app.innerHTML = '<div class="empty">' + escapeHtml(error.message || 'Failed to load state') + '</div>';
      });
    </script>
  </body>
</html>`;
}

export async function startAdminWebServer(
  opts: AdminWebServerOptions,
): Promise<void> {
  if (adminServer) return;

  adminServer = http.createServer(async (req, res) => {
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`,
    );

    try {
      if (req.method === 'GET' && url.pathname === '/api/admin/state') {
        sendJson(res, 200, {
          ...readAdminState(opts.projectRoot),
          web: { host: opts.host, port: opts.port },
          map: readAdminMapState(opts.projectRoot),
        });
        return;
      }

      if (
        req.method === 'GET' &&
        url.pathname === '/api/admin/dashboard-preview'
      ) {
        const force = url.searchParams.get('force') === '1';
        sendJson(res, 200, {
          ok: true,
          ...(await getUnifiedDashboardPreview(force)),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/chat/history') {
        const teamId = url.searchParams.get('teamId');
        if (!teamId) {
          sendJson(res, 400, { error: 'teamId is required' });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          history: readAdminChatHistory(opts.projectRoot, { teamId }),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/') {
        sendHtml(res, renderAdminGamePage());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/vendor/phaser.min.js') {
        sendScript(res, renderAdminPhaserBundle());
        return;
      }

      if (req.method === 'GET' && url.pathname.startsWith('/admin-assets/')) {
        sendStaticFile(
          res,
          path.join(opts.projectRoot, 'admin-assets'),
          url.pathname.slice('/admin-assets/'.length),
        );
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/admin/services/upsert'
      ) {
        const payload = serviceConfigSchema.parse(await readJsonBody(req));
        const result = upsertServiceConfig(opts.projectRoot, payload);
        const applyResult = await applyTopologyReconcile(opts.projectRoot, {
          verifyServiceId: result.serviceId,
          restartServiceId: payload.existingServiceId
            ? result.serviceId
            : undefined,
        });
        sendJson(res, 200, {
          ok: true,
          ...result,
          ...applyResult,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/services/logs') {
        const serviceId = String(url.searchParams.get('serviceId') || '').trim();
        const maxLines = Number(url.searchParams.get('lines') || '120');
        if (!serviceId) {
          throw new InvalidAdminInputError('serviceId is required');
        }
        const logs = readServiceLogs(opts.projectRoot, serviceId, {
          maxLines: Number.isFinite(maxLines) ? maxLines : 120,
        });
        sendJson(res, 200, {
          ok: true,
          ...logs,
        });
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/admin/services/temperament'
      ) {
        const payload = serviceTemperamentSchema.parse(await readJsonBody(req));
        const result = assignServiceTemperamentConfig(
          opts.projectRoot,
          payload,
        );
        sendJson(res, 200, {
          ok: true,
          ...result,
        });
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/admin/services/delete'
      ) {
        const payload = serviceDeleteSchema.parse(await readJsonBody(req));
        deleteServiceConfig(opts.projectRoot, payload.serviceId);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/admin/services/action'
      ) {
        const payload = serviceActionSchema.parse(await readJsonBody(req));
        const result = runServiceAction(
          opts.projectRoot,
          payload.serviceId,
          payload.action,
        );
        sendJson(res, result.scheduled ? 202 : 200, {
          ok: true,
          ...result,
        });
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/admin/assignments/toggle'
      ) {
        const payload = assignmentToggleSchema.parse(await readJsonBody(req));
        const result = toggleChannelAssignment(opts.projectRoot, payload);
        sendJson(res, result.scheduled ? 202 : 200, {
          ok: true,
          ...result,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/admin/teams/upsert') {
        const payload = officeTeamSchema.parse(await readJsonBody(req));
        const result = upsertOfficeTeamConfig(opts.projectRoot, payload);
        sendJson(res, 200, {
          ok: true,
          ...result,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/admin/teams/layout') {
        const payload = officeTeamLayoutSchema.parse(await readJsonBody(req));
        const result = upsertOfficeTeamLayoutConfig(opts.projectRoot, payload);
        sendJson(res, 200, {
          ok: true,
          ...result,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/admin/rooms/layout') {
        const payload = officeRoomLayoutSchema.parse(await readJsonBody(req));
        const result = upsertOfficeRoomLayoutConfig(opts.projectRoot, payload);
        sendJson(res, 200, {
          ok: true,
          ...result,
        });
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/admin/company/upsert'
      ) {
        const payload = companySettingsSchema.parse(await readJsonBody(req));
        upsertOfficeCompanySettingsConfig(opts.projectRoot, payload);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/admin/temperaments/upsert'
      ) {
        const payload = temperamentDefinitionSchema.parse(
          await readJsonBody(req),
        );
        const result = upsertTemperamentConfig(opts.projectRoot, payload);
        sendJson(res, 200, {
          ok: true,
          ...result,
        });
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/admin/temperaments/delete'
      ) {
        const payload = temperamentDeleteSchema.parse(await readJsonBody(req));
        deleteTemperamentConfig(opts.projectRoot, payload.temperamentId);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/admin/teams/delete') {
        const payload = officeTeamDeleteSchema.parse(await readJsonBody(req));
        deleteOfficeTeamConfig(opts.projectRoot, payload.teamId);
        sendJson(res, 200, {
          ok: true,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/admin/map/upload') {
        const payload = mapUploadSchema.parse(
          await readJsonBody(req, 20 * 1024 * 1024),
        );
        const map = uploadAdminMapAssets(opts.projectRoot, payload);
        sendJson(res, 200, {
          ok: true,
          map,
        });
        return;
      }

      if (
        req.method === 'POST' &&
        url.pathname === '/api/admin/topology/reconcile'
      ) {
        const result = await applyTopologyReconcile(opts.projectRoot);
        sendJson(res, 200, {
          ok: true,
          ...result,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/admin/chat') {
        const payload = adminChatSchema.parse(await readJsonBody(req));
        const result = await runAdminChat(opts.projectRoot, payload);
        sendJson(res, 200, {
          ok: true,
          ...result,
        });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      logger.error({ err, path: url.pathname }, 'Admin web request failed');
      const message = err instanceof Error ? err.message : String(err);
      const statusCode =
        err instanceof z.ZodError ||
        err instanceof InvalidAdminInputError ||
        message === 'Request body too large' ||
        message.includes('JSON')
          ? 400
          : 500;
      sendJson(res, statusCode, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    adminServer!.once('error', reject);
    adminServer!.listen(opts.port, opts.host, () => resolve());
  });

  logger.info({ host: opts.host, port: opts.port }, 'HKClaw admin web started');
}
