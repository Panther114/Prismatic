declare module "@napi-rs/canvas" {
  export type SKRSContext2D = any;
  export type Canvas = any;
  export type Image = any;
  export function createCanvas(width: number, height: number): Canvas;
  export function loadImage(source: string | Buffer): Promise<Image>;
}
