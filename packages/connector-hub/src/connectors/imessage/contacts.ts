import Database from "better-sqlite3";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Names for iMessage handles, read from the Contacts databases on this Mac.
 *
 * Messages itself stores only the handle (a phone number or an email); the
 * name you see in Messages comes from Contacts. The connector reads the same
 * source, read-only: every `AddressBook-v22.abcddb` under the AddressBook
 * folder (the local store plus one per account under `Sources/`). The same
 * Full Disk Access grant that covers chat.db covers these files.
 *
 * Lookups never throw. When the folder is missing or unreadable the directory
 * is empty, says why in `detail`, and the connector falls back to handles.
 * The files are re-read when any of them changes on disk, so adding a contact
 * in Contacts renames the conversation on the next poll.
 */

export const CONTACTS_DB_FILENAME = "AddressBook-v22.abcddb";

/** The subset of the Contacts schema the directory queries; checked after every open. */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  ZABCDRECORD: ["Z_PK", "ZFIRSTNAME", "ZLASTNAME", "ZNICKNAME", "ZORGANIZATION"],
  ZABCDPHONENUMBER: ["ZOWNER", "ZFULLNUMBER"],
  ZABCDEMAILADDRESS: ["ZOWNER", "ZADDRESS"],
};

/** Phone numbers at least this long also match on their trailing digits, so "(703) 550-1177" matches "+17035501177". */
const SUFFIX_MATCH_DIGITS = 10;

type RecordRow = { Z_PK: number; ZFIRSTNAME: string | null; ZLASTNAME: string | null; ZNICKNAME: string | null; ZORGANIZATION: string | null };
type PhoneRow = { ZOWNER: number | null; ZFULLNUMBER: string | null };
type EmailRow = { ZOWNER: number | null; ZADDRESS: string | null };

export type ContactsSnapshot = {
  /** Readable database files, in the order they were consulted (the first match wins). */
  files: string[];
  /** Distinct handles (phones and emails) that resolve to a name. */
  handles: number;
  /** Why some or all files could not be read, in words; empty when everything loaded. */
  detail: string;
};

export class ContactsDirectory {
  private readonly dir: string;
  private byDigits = new Map<string, string>();
  private bySuffix = new Map<string, string>();
  private byEmail = new Map<string, string>();
  private signature: string | null = null;
  private snapshot: ContactsSnapshot = { files: [], handles: 0, detail: "Not loaded." };

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Name for a Messages handle (phone or email), or null when Contacts has none. */
  lookup(handle: string): string | null {
    const h = handle.trim();
    if (h.length === 0) return null;
    if (h.includes("@")) return this.byEmail.get(h.toLowerCase()) ?? null;
    const digits = digitsOf(h);
    if (digits.length === 0) return null;
    return this.byDigits.get(digits) ?? (digits.length >= SUFFIX_MATCH_DIGITS ? (this.bySuffix.get(digits.slice(-SUFFIX_MATCH_DIGITS)) ?? null) : null);
  }

  /** The name for a handle, or the handle itself. */
  nameFor(handle: string): string {
    return this.lookup(handle) ?? handle;
  }

  status(): ContactsSnapshot {
    return this.snapshot;
  }

  /**
   * Re-reads the databases when any changed since the last call (or on the
   * first call). Returns true when the directory's contents changed. Never throws.
   */
  refresh(): boolean {
    const files = this.candidateFiles();
    const signature = files.map((f) => `${f}:${mtimeOf(f)}:${mtimeOf(f + "-wal")}`).join("|");
    if (signature === this.signature) return false;
    this.signature = signature;
    const byDigits = new Map<string, string>();
    const bySuffix = new Map<string, string>();
    const byEmail = new Map<string, string>();
    const loaded: string[] = [];
    const problems: string[] = [];

    for (const file of files) {
      try {
        readOne(file, byDigits, bySuffix, byEmail);
        loaded.push(file);
      } catch (err) {
        problems.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.byDigits = byDigits;
    this.bySuffix = bySuffix;
    this.byEmail = byEmail;

    let detail = "";
    if (files.length === 0) detail = `No Contacts database found under ${this.dir}; conversations are named by phone number or email.`;
    else if (loaded.length === 0) detail = `Contacts could not be read (${problems.join("; ")}); conversations are named by phone number or email.`;
    else if (problems.length > 0) detail = `Some Contacts databases could not be read: ${problems.join("; ")}.`;
    this.snapshot = { files: loaded, handles: byDigits.size + byEmail.size, detail };
    return true;
  }

  private candidateFiles(): string[] {
    const files: string[] = [];
    const root = join(this.dir, CONTACTS_DB_FILENAME);
    if (existsSync(root)) files.push(root);
    const sources = join(this.dir, "Sources");
    let entries: string[] = [];
    try {
      entries = existsSync(sources) ? readdirSync(sources).sort() : [];
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const file = join(sources, entry, CONTACTS_DB_FILENAME);
      if (existsSync(file)) files.push(file);
    }
    return files;
  }
}

function readOne(file: string, byDigits: Map<string, string>, bySuffix: Map<string, string>, byEmail: Map<string, string>): void {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    checkSchema(db);
    const names = new Map<number, string>();
    for (const r of db.prepare("SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZNICKNAME, ZORGANIZATION FROM ZABCDRECORD").all() as RecordRow[]) {
      const name = displayNameOf(r);
      if (name) names.set(r.Z_PK, name);
    }
    for (const p of db.prepare("SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER").all() as PhoneRow[]) {
      const name = p.ZOWNER === null ? undefined : names.get(p.ZOWNER);
      const digits = p.ZFULLNUMBER ? digitsOf(p.ZFULLNUMBER) : "";
      if (!name || digits.length === 0) continue;
      if (!byDigits.has(digits)) byDigits.set(digits, name);
      if (digits.length >= SUFFIX_MATCH_DIGITS) {
        const suffix = digits.slice(-SUFFIX_MATCH_DIGITS);
        if (!bySuffix.has(suffix)) bySuffix.set(suffix, name);
      }
    }
    for (const e of db.prepare("SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS").all() as EmailRow[]) {
      const name = e.ZOWNER === null ? undefined : names.get(e.ZOWNER);
      const address = e.ZADDRESS?.trim().toLowerCase() ?? "";
      if (!name || address.length === 0) continue;
      if (!byEmail.has(address)) byEmail.set(address, name);
    }
  } finally {
    db.close();
  }
}

function checkSchema(db: Database.Database): void {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (info.length === 0) throw new Error(`no table "${table}"`);
    const have = new Set(info.map((c) => c.name));
    for (const column of columns) {
      if (!have.has(column)) throw new Error(`table "${table}" has no column "${column}"`);
    }
  }
}

/** "First Last", else the nickname, else the organization, as Contacts shows a card. */
export function displayNameOf(r: { ZFIRSTNAME: string | null; ZLASTNAME: string | null; ZNICKNAME: string | null; ZORGANIZATION: string | null }): string | null {
  const full = [r.ZFIRSTNAME, r.ZLASTNAME].map((s) => s?.trim() ?? "").filter((s) => s.length > 0).join(" ");
  if (full) return full;
  const nick = r.ZNICKNAME?.trim();
  if (nick) return nick;
  const org = r.ZORGANIZATION?.trim();
  return org || null;
}

/** The digits of a phone number, without any extension ("555-0100;123" and "555-0100 x123" both give 5550100). */
export function digitsOf(number: string): string {
  const main = number.split(/[;xX#,]/)[0] ?? "";
  return main.replace(/\D/g, "");
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
