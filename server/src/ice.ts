import { createHmac } from 'node:crypto';
import type { IceServerConfig } from '@pizzadrop/shared';
import type { Config } from './config.js';

/**
 * ICE servers handed to each browser in the `hello` message.
 *
 * STUN is always included. TURN is optional and supports two modes:
 *  - static credentials (`TURN_USERNAME` / `TURN_CREDENTIAL`), or
 *  - coturn's TURN REST API (`TURN_SECRET` = coturn `static-auth-secret`):
 *    username = `<unix-expiry>:pizzadrop`, credential = base64(HMAC-SHA1(secret, username)).
 *    These expire on their own, so leaking one from a browser is low-risk.
 */
export function buildIceServers(config: Config, nowMs: number = Date.now()): IceServerConfig[] {
  const servers: IceServerConfig[] = [];
  if (config.stunUrls.length > 0) servers.push({ urls: config.stunUrls });

  if (config.turnUrls.length > 0) {
    if (config.turnSecret) {
      const expiry = Math.floor(nowMs / 1000) + config.turnCredentialTtlSec;
      const username = `${expiry}:pizzadrop`;
      const credential = createHmac('sha1', config.turnSecret).update(username).digest('base64');
      servers.push({ urls: config.turnUrls, username, credential });
    } else if (config.turnUsername && config.turnCredential) {
      servers.push({ urls: config.turnUrls, username: config.turnUsername, credential: config.turnCredential });
    } else {
      servers.push({ urls: config.turnUrls });
    }
  }
  return servers;
}
