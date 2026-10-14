/**
 * World layout (Y up). The table lies in the XZ plane, centered on the origin.
 * The shooter stands at the +Z edge (nearest the camera) and throws toward -Z,
 * where the back wall bounces the dice.
 */
export const DIE_SIZE = 1.2;
export const TABLE_WIDTH = 10; // X
export const TABLE_LENGTH = 14; // Z
export const WALL_HEIGHT = 12;
export const GRAVITY = -50;

/** Where the dice are held before a throw. */
export const HAND_Z = TABLE_LENGTH / 2 - 1.3;
export const HAND_Y = 1.8;
/** Distance between the two dice centres in hand; must exceed the die diagonal so they never start overlapping. */
export const HAND_SPREAD = DIE_SIZE * 1.9;
