// Minimal ambient type declarations for the pure-JS `gifenc` GIF encoder.
// The package ships no .d.ts; we only use the three functions below.
declare module "gifenc" {
  export interface WriteFrameOpts {
    palette?: number[][];
    /** Frame delay in milliseconds. */
    delay?: number;
    /** Loop count for the whole GIF (0 = loop forever). Set on the first frame. */
    repeat?: number;
    transparent?: boolean;
    transparentIndex?: number;
    dispose?: number;
    first?: boolean;
  }

  export interface GifEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: WriteFrameOpts
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
  }

  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): GifEncoderInstance;

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: Record<string, unknown>
  ): number[][];

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: string
  ): Uint8Array;
}
