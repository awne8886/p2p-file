/** Random hex id. Uses getRandomValues, which (unlike crypto.randomUUID) also works over plain http on a LAN. */
export function randomId(bytes = 12): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}
