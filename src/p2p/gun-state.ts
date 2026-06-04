/**
 * Parser for Unturned gun item State blobs.
 *
 * Byte layout (verified against real data, all multi-byte values little-endian):
 *   [0..1]  sight     (UInt16 LE)
 *   [2..3]  tactical  (UInt16 LE)
 *   [4..5]  grip      (UInt16 LE)
 *   [6..7]  barrel    (UInt16 LE)
 *   [8..9]  magazine  (UInt16 LE)
 *   [10]    ammo      (UInt8)
 *   [11]    firemode  (UInt8)
 * An attachment id of 0 means the slot is empty.
 */
export interface GunState {
  sight: number;
  tactical: number;
  grip: number;
  barrel: number;
  magazine: number;
  ammo: number;
  firemode: number;
  /** True when any attachment slot (NOT ammo) is occupied. */
  hasAttachments: boolean;
}

/** A resolved attachment slot: the id plus its catalog name (null when not in sv_items). */
export type AttachView = { id: number; name: string | null } | null;

/** Enriched gun view returned on listing/vault item read endpoints. */
export interface GunView {
  sight: AttachView;
  tactical: AttachView;
  grip: AttachView;
  barrel: AttachView;
  magazine: AttachView;
  ammo: number;
  hasAttachments: boolean;
}

/**
 * Decode a base64 gun-state string into its attachment/ammo fields.
 * Returns null when the input is empty/invalid or too short to be a gun state
 * (needs at least 11 bytes: 5 UInt16 ids + the ammo byte).
 */
export function parseGunState(stateB64: string | null | undefined): GunState | null {
  if (!stateB64) return null;

  let buf: Buffer;
  try {
    buf = Buffer.from(stateB64, 'base64');
  } catch {
    return null;
  }
  // Reject inputs that decoded to nothing or are too short for the gun layout.
  if (buf.length < 11) return null;

  const sight = buf.readUInt16LE(0);
  const tactical = buf.readUInt16LE(2);
  const grip = buf.readUInt16LE(4);
  const barrel = buf.readUInt16LE(6);
  const magazine = buf.readUInt16LE(8);
  const ammo = buf.readUInt8(10);
  // firemode lives at byte 11 but may be absent on shorter-but-valid blobs.
  const firemode = buf.length >= 12 ? buf.readUInt8(11) : 0;

  const hasAttachments = (sight || tactical || grip || barrel || magazine) !== 0;

  return { sight, tactical, grip, barrel, magazine, ammo, firemode, hasAttachments };
}

/** Collect every non-zero attachment id from a parsed gun state (for batch name lookup). */
export function collectAttachmentIds(g: GunState): number[] {
  return [g.sight, g.tactical, g.grip, g.barrel, g.magazine].filter((id) => id !== 0);
}

/**
 * Build the enriched GunView from a parsed gun state and a (id -> name) lookup map.
 * A slot id of 0 -> null; otherwise { id, name } with name null when absent from the map.
 */
export function buildGunView(g: GunState, names: Map<number, string | null>): GunView {
  const slot = (id: number): AttachView => (id === 0 ? null : { id, name: names.get(id) ?? null });
  return {
    sight: slot(g.sight),
    tactical: slot(g.tactical),
    grip: slot(g.grip),
    barrel: slot(g.barrel),
    magazine: slot(g.magazine),
    ammo: g.ammo,
    hasAttachments: g.hasAttachments,
  };
}
