const NAME_KEY = "dice.name";
const ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L

export function storedName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

export function storeName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // storage unavailable (private mode); the name just won't be remembered
  }
}

export function sanitizeRoom(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
}

export function newRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join("");
}

/** The room from ?room=, or a fresh code written back into the URL so it can be shared. */
export function standaloneRoom(): string {
  const url = new URL(location.href);
  const fromUrl = sanitizeRoom(url.searchParams.get("room") ?? "").toUpperCase();
  if (fromUrl) return fromUrl;
  const room = newRoomCode();
  url.searchParams.set("room", room);
  history.replaceState(null, "", url);
  return room;
}

export function inviteLink(room: string, transport: string): string {
  const url = new URL(location.origin + location.pathname);
  url.searchParams.set("room", room);
  if (transport === "relay") url.searchParams.set("t", "relay");
  return url.toString();
}
