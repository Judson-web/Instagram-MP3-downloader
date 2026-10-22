import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

async function generateOpenGraphCard(): Promise<void> {
  const publicDirectory = path.join(process.cwd(), "public");
  const sourcePath = path.join(publicDirectory, "og-card.svg");
  const outputPath = path.join(publicDirectory, "og-card.png");

  const source = await fs.readFile(sourcePath);
  await sharp(source, { density: 144 })
    .resize(1200, 630, { fit: "cover", position: "centre" })
    .png({ compressionLevel: 9, palette: true, quality: 90, effort: 8 })
    .toFile(outputPath);

  const metadata = await sharp(outputPath).metadata();
  if (metadata.width !== 1200 || metadata.height !== 630 || metadata.format !== "png") {
    await fs.rm(outputPath, { force: true });
    throw new Error("The social preview must be a 1200 × 630 PNG image.");
  }

  console.info("Generated the 1200 × 630 ReelTone social preview.");
}

generateOpenGraphCard().catch((error: unknown) => {
  console.error("Unable to generate the ReelTone social preview.", error);
  process.exitCode = 1;
});
