import { createHmac, randomBytes } from 'crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function newAuthenticatorKey(): string {
  const bytes = randomBytes(20);
  let bits = '';
  for (const byte of bytes) {
    bits += byte.toString(2).padStart(8, '0');
  }
  let key = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    key += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  }
  return key;
}

export function totp(key: string, at: number = Date.now()): string {
  const secret = decodeBase32(key);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(currentStep(at)));
  const hash = createHmac('sha1', secret).update(counter).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const value = (hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(value).padStart(DIGITS, '0');
}

export function currentStep(at: number = Date.now()): number {
  return Math.floor(at / 1000 / STEP_SECONDS);
}

export function secondsLeftInStep(at: number = Date.now()): number {
  return STEP_SECONDS - (Math.floor(at / 1000) % STEP_SECONDS);
}

function decodeBase32(key: string): Buffer {
  let bits = '';
  for (const char of key.replace(/[\s=-]/g, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('The authenticator key is not base32.');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}
