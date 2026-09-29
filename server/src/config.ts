import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CODE_LENGTH, MAX_CODE_LENGTH, MIN_CODE_LENGTH } from '@pizzadrop/shared';

export interface Config {
  port: number;
  host: string;
  /** Canonical origin for share links, e.g. `https://pzza.app`. `null` → the client uses its own origin. */
  publicUrl: string | null;
  /** Directory holding the built client (`client/dist`). `null` disables static hosting. */
  staticDir: string | null;
  codeLength: number;
  /** A code expires after this long without any signaling activity (ms). */
  roomIdleTtlMs: number;
  /** How long a code survives a sender's socket dropping without a clean `close` (ms). */
  hostGraceMs: number;
  maxPeersPerRoom: number;
  stunUrls: string[];
  turnUrls: string[];
  turnUsername: string | null;
  turnCredential: string | null;
  /** coturn `static-auth-secret`; when set, short-lived TURN credentials are minted per connection. */
  turnSecret: string | null;
  turnCredentialTtlSec: number;
  /** Honour `X-Forwarded-For` (only enable behind a trusted reverse proxy). */
  trustProxy: boolean;
  /** If non-empty, WebSocket upgrades from other `Origin`s are refused. */
  allowedOrigins: string[];
}

const DEFAULT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

function list(env: NodeJS.ProcessEnv, key: string, fallback: string[]): string[] {
  const raw = env[key];
  if (raw === undefined) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function str(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key]?.trim();
  return v ? v : null;
}

function bool(env: NodeJS.ProcessEnv, key: string): boolean {
  return /^(1|true|yes|on)$/i.test(env[key] ?? '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const staticRaw = env.STATIC_DIR;
  const staticDir =
    staticRaw === undefined
      ? path.resolve(here, '../../client/dist')
      : staticRaw.trim() === ''
        ? null
        : path.resolve(staticRaw);

  const publicUrl = str(env, 'PUBLIC_URL');
  if (publicUrl && !/^https?:\/\/[^/]+$/.test(publicUrl)) {
    throw new Error('PUBLIC_URL must be an origin like https://pzza.app (no trailing slash or path)');
  }

  return {
    port: int(env, 'PORT', 8080, 1, 65535),
    host: env.HOST?.trim() || '0.0.0.0',
    publicUrl,
    staticDir,
    codeLength: int(env, 'CODE_LENGTH', DEFAULT_CODE_LENGTH, MIN_CODE_LENGTH, MAX_CODE_LENGTH),
    roomIdleTtlMs: int(env, 'ROOM_IDLE_TTL_SECONDS', 24 * 60 * 60, 60, 30 * 24 * 60 * 60) * 1000,
    hostGraceMs: int(env, 'HOST_GRACE_SECONDS', 20, 0, 600) * 1000,
    maxPeersPerRoom: int(env, 'MAX_PEERS_PER_ROOM', 32, 1, 1000),
    stunUrls: list(env, 'STUN_URLS', DEFAULT_STUN),
    turnUrls: list(env, 'TURN_URLS', []),
    turnUsername: str(env, 'TURN_USERNAME'),
    turnCredential: str(env, 'TURN_CREDENTIAL'),
    turnSecret: str(env, 'TURN_SECRET'),
    turnCredentialTtlSec: int(env, 'TURN_CREDENTIAL_TTL_SECONDS', 24 * 60 * 60, 60, 7 * 24 * 60 * 60),
    trustProxy: bool(env, 'TRUST_PROXY'),
    allowedOrigins: list(env, 'ALLOWED_ORIGINS', []),
  };
}
