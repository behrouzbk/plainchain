import type { StateDb } from "./db.js";

const KEY = "addressBook";

/** The persisted address book: whatever `AddressBook.toJSON()` produced, or undefined. */
export async function loadAddressBookJson(db: StateDb): Promise<unknown> {
  const raw = await db.peers.get(KEY);
  return raw === undefined ? undefined : JSON.parse(raw);
}

export async function saveAddressBookJson(db: StateDb, records: unknown): Promise<void> {
  await db.peers.put(KEY, JSON.stringify(records));
}
