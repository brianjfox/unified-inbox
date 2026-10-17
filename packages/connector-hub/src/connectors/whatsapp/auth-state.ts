import sodium from "libsodium-wrappers-sumo";
import { BufferJSON, initAuthCreds } from "@whiskeysockets/baileys";
import WAProto from "@whiskeysockets/baileys/WAProto/index.js";
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from "@whiskeysockets/baileys";
import type { HubStore } from "../../store.ts";

/**
 * Baileys' auth state, persisted in the hub database with every record
 * encrypted (XChaCha20-Poly1305) under a key that lives only in the macOS
 * keychain. Same contract as Baileys' useMultiFileAuthState, so the socket
 * is none the wiser: `state.creds`, `state.keys.get/set`, and `saveCreds`.
 *
 * The keychain holds the key; the database holds ciphertext (NFR-3, AC-19).
 */

/** The keychain item that holds the base64 32-byte key. */
export const WHATSAPP_AUTH_KEYCHAIN_ITEM = "whatsapp-auth-key";
export const WHATSAPP_AUTH_KEY_BYTES = 32;

/** The row that holds the credentials; every other row is `${type}-${id}`. */
const CREDS_ROW = "creds";

export class WhatsAppAuthStateError extends Error {}

/** The subset of the store the auth state needs; tests can hand in a HubStore(":memory:"). */
export type WhatsAppAuthStore = Pick<HubStore, "whatsappAuthGet" | "whatsappAuthSet" | "whatsappAuthDelete" | "whatsappAuthClear">;

export type EncryptedAuthState = {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
};

export async function generateAuthKey(): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.randombytes_buf(WHATSAPP_AUTH_KEY_BYTES);
}

export function authKeyToString(key: Uint8Array): string {
  return Buffer.from(key).toString("base64");
}

export function authKeyFromString(value: string): Uint8Array {
  const key = new Uint8Array(Buffer.from(value, "base64"));
  assertKey(key);
  return key;
}

function assertKey(key: Uint8Array): void {
  if (key.length !== WHATSAPP_AUTH_KEY_BYTES) {
    throw new WhatsAppAuthStateError(`The WhatsApp auth key must be ${WHATSAPP_AUTH_KEY_BYTES} bytes; got ${key.length}.`);
  }
}

/**
 * Encrypts one record. The row key is bound in as additional data, so a
 * ciphertext moved to another row fails to open. Layout: nonce || ciphertext.
 */
export function encryptRecord(key: Uint8Array, rowKey: string, plaintext: string): Uint8Array {
  assertKey(key);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const sealed = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(sodium.from_string(plaintext), sodium.from_string(rowKey), null, nonce, key);
  const out = new Uint8Array(nonce.length + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, nonce.length);
  return out;
}

export function decryptRecord(key: Uint8Array, rowKey: string, blob: Uint8Array): string {
  assertKey(key);
  const nonceBytes = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (blob.length < nonceBytes + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES) {
    throw new WhatsAppAuthStateError(`The WhatsApp auth record "${rowKey}" is too short to be a sealed record (${blob.length} bytes).`);
  }
  const nonce = blob.subarray(0, nonceBytes);
  const sealed = blob.subarray(nonceBytes);
  try {
    return sodium.to_string(sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, sealed, sodium.from_string(rowKey), nonce, key));
  } catch (err) {
    throw new WhatsAppAuthStateError(
      `The WhatsApp auth record "${rowKey}" could not be decrypted with the key in the keychain item "${WHATSAPP_AUTH_KEYCHAIN_ITEM}". ` +
        `If the keychain item was replaced, relink WhatsApp from the Connections screen. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/** Whether saved credentials describe a completed link. */
export function hasLinkedSession(creds: AuthenticationCreds): boolean {
  return creds.registered === true || !!creds.me?.id;
}

/**
 * Opens the auth state. A missing creds row means a fresh session
 * (`initAuthCreds()`); a creds row that will not decrypt is an error, never
 * silently a fresh session, so a wrong key cannot wipe a live link.
 */
export async function useEncryptedSqliteAuthState(store: WhatsAppAuthStore, key: Uint8Array): Promise<EncryptedAuthState> {
  await sodium.ready;
  assertKey(key);

  const write = (rowKey: string, value: unknown): void => {
    store.whatsappAuthSet(rowKey, encryptRecord(key, rowKey, JSON.stringify(value, BufferJSON.replacer)));
  };
  const read = (rowKey: string): unknown => {
    const blob = store.whatsappAuthGet(rowKey);
    if (!blob) return null;
    return JSON.parse(decryptRecord(key, rowKey, blob), BufferJSON.reviver);
  };

  const stored = read(CREDS_ROW) as AuthenticationCreds | null;
  const creds: AuthenticationCreds = stored ?? initAuthCreds();

  const keys: AuthenticationState["keys"] = {
    get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const data: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const id of ids) {
        let value = read(`${type}-${id}`);
        if (value === null || value === undefined) continue;
        if (type === "app-state-sync-key") {
          value = WAProto.proto.Message.AppStateSyncKeyData.fromObject(value as Record<string, unknown>);
        }
        data[id] = value as SignalDataTypeMap[T];
      }
      return data;
    },
    set: (data: SignalDataSet) => {
      for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
        const records = data[category];
        if (!records) continue;
        for (const [id, value] of Object.entries(records)) {
          const rowKey = `${category}-${id}`;
          if (value === null || value === undefined) store.whatsappAuthDelete(rowKey);
          else write(rowKey, value);
        }
      }
    },
    clear: () => {
      store.whatsappAuthClear();
    },
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {
      write(CREDS_ROW, creds);
    },
  };
}
