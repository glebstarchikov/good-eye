import sharp from "sharp";
import { BasicPipeline, Vibrant } from "@vibrant/core";
import { ImageBase, type ImageData, type ImageSource } from "@vibrant/image";
import { MMCQ } from "@vibrant/quantizer-mmcq";
import { DefaultGenerator } from "@vibrant/generator-default";

// node-vibrant/node, rebuilt from its own parts with sharp decoding the image. node-vibrant's
// decoder is jimp 0.22, which pins file-type 16: that has an infinite-loop advisory fixed only in
// file-type 21, whose API jimp 0.22 can't call. The pipeline is node-vibrant's, line for line.
Vibrant.use(
  new BasicPipeline().filter
    .register("default", (r: number, g: number, b: number, a: number) => a >= 125 && !(r > 250 && g > 250 && b > 250))
    .quantizer.register("mmcq", MMCQ)
    .generator.register("default", DefaultGenerator),
);

/** node-vibrant's default quality: it samples the image at a fifth of its width and height. */
const SCALE = 5;

/** sharp is async and Vibrant's resize() is not, so load() decodes and shrinks in one go, and
 * extractPalette runs Vibrant at quality 1 so it never shrinks the image a second time. The
 * bilinear kernel is jimp's default; on the library's screenshots it keeps swatches closest to the
 * ones node-vibrant gave (median shift 8 on the 0-441 RGB distance scale; lanczos3 gave 12). */
class SharpImage extends ImageBase {
  private image: ImageData | undefined;

  async load(src: ImageSource): Promise<SharpImage> {
    if (typeof src !== "string") throw new Error("SharpImage reads image files only");
    const { width = 1 } = await sharp(src).metadata();
    const { data, info } = await sharp(src)
      .resize({ width: Math.max(1, Math.round(width / SCALE)), kernel: "linear" })
      .ensureAlpha() // Vibrant reads 4 bytes a pixel; sharp's raw output is sRGB, so greyscale comes out RGB(A)
      .raw()
      .toBuffer({ resolveWithObject: true });
    this.image = { data, width: info.width, height: info.height };
    return this;
  }

  getImageData(): ImageData {
    if (!this.image) throw new Error("Image not loaded");
    return this.image;
  }
  getWidth() { return this.getImageData().width; }
  getHeight() { return this.getImageData().height; }
  getPixelCount() { return this.getWidth() * this.getHeight(); }
  resize() { /* never called: extractPalette runs at quality 1 */ }
  clear() {}
  update() {}
  remove() {}
}

/** The image's swatches (Vibrant, Muted, DarkVibrant, ...), as tokens.json stores them. */
export async function extractPalette(imagePath: string) {
  const palette = await Vibrant.from(imagePath)
    .useImageClass(SharpImage)
    .quality(1)
    .useQuantizer("mmcq")
    .useGenerator("default")
    .addFilter("default")
    .getPalette();
  return Object.entries(palette)
    .filter(([, swatch]) => swatch)
    .map(([name, swatch]) => ({ name, hex: swatch!.hex, population: swatch!.population }));
}
