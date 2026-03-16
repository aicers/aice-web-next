import "server-only";

import commonPasswords from "./common-passwords-top-100k.json";

/**
 * Bundled offline password blocklist built from the first 100,000 unique
 * lowercase entries in SecLists xato-net-10-million-passwords-1000000.txt.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set(commonPasswords);

export const PASSWORD_BLOCKLIST_SIZE = COMMON_PASSWORDS.size;

export function isBlocklisted(password: string): boolean {
  return COMMON_PASSWORDS.has(password.trim().toLowerCase());
}
