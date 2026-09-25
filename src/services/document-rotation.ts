import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { PDFDocument, degrees } from 'pdf-lib';

export type RotationDeg = 0 | 90 | 180 | 270;

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif']);

export function parseRotationDeg(value: unknown): RotationDeg | null {
  if (value === 0 || value === 90 || value === 180 || value === 270) {
    return value;
  }
  return null;
}

export function normalizeRotationDeg(
  value: unknown,
  fallback: RotationDeg = 0,
): RotationDeg {
  return parseRotationDeg(value) ?? fallback;
}

function normalizeFileExtension(ext: string): string {
  if (ext === '.jpeg') return '.jpg';
  return ext;
}

async function rotatePdfFile(
  sourcePath: string,
  outputPath: string,
  rotationDeg: RotationDeg,
  targetOrientation?: 'portrait' | 'landscape',
): Promise<void> {
  const bytes = await fs.promises.readFile(sourcePath);
  const pdf = await PDFDocument.load(bytes);

  for (const page of pdf.getPages()) {
    const current = page.getRotation().angle;
    let extraRotation = 0;

    if (targetOrientation) {
      const w = page.getWidth();
      const h = page.getHeight();
      const isLandscape = w > h;
      const wantsLandscape = targetOrientation === 'landscape';
      if (isLandscape !== wantsLandscape) {
        extraRotation = 90;
      }
    }

    const next = ((current + rotationDeg + extraRotation) % 360 + 360) % 360;
    if (next !== current) {
      page.setRotation(degrees(next));
    }
  }

  // Always save if we need to enforce orientation or if rotation was requested
  const rotatedBytes = await pdf.save();
  await fs.promises.writeFile(outputPath, rotatedBytes);
}

async function rotateImageFile(
  sourcePath: string,
  outputPath: string,
  rotationDeg: RotationDeg,
  targetOrientation?: 'portrait' | 'landscape',
): Promise<void> {
  const image = sharp(sourcePath).rotate(); // auto-orient based on EXIF first
  const metadata = await image.metadata();
  const w = metadata.width || 0;
  const h = metadata.height || 0;

  let extraRotation = 0;
  if (targetOrientation && w > 0 && h > 0) {
    const isLandscape = w > h;
    const wantsLandscape = targetOrientation === 'landscape';
    if (isLandscape !== wantsLandscape) {
      extraRotation = 90;
    }
  }

  const finalRotation = (rotationDeg + extraRotation) % 360;
  if (finalRotation !== 0) {
    await image.rotate(finalRotation).toFile(outputPath);
  } else {
    await image.toFile(outputPath);
  }
}

async function rotateFileToPath(
  sourcePath: string,
  outputPath: string,
  rotationDeg: RotationDeg,
  targetOrientation?: 'portrait' | 'landscape',
): Promise<void> {
  const extension = path.extname(sourcePath).toLowerCase();
  if (extension === '.pdf') {
    await rotatePdfFile(sourcePath, outputPath, rotationDeg, targetOrientation);
    return;
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    await rotateImageFile(sourcePath, outputPath, rotationDeg, targetOrientation);
    return;
  }
  throw new Error(
    `Rotation is not supported for ${extension || 'this'} file type.`,
  );
}

export async function prepareScanRotationArtifact(input: {
  sourcePath: string;
  orientation: 'portrait' | 'landscape';
  rotationDeg: RotationDeg;
}): Promise<{ filePath: string; transformed: boolean }> {
  const { sourcePath, orientation, rotationDeg } = input;
  const orientationRotation = orientation === 'landscape' ? 90 : 0;
  const finalRotation = normalizeRotationDeg(
    (orientationRotation + rotationDeg) % 360,
  );

  if (finalRotation === 0) {
    return { filePath: sourcePath, transformed: false };
  }

  const sourceExt = normalizeFileExtension(path.extname(sourcePath).toLowerCase());
  if (sourceExt !== '.pdf' && !IMAGE_EXTENSIONS.has(sourceExt)) {
    throw new Error(
      `Rotation is not supported for ${sourceExt || 'this'} scan format.`,
    );
  }

  const outputPath = path.join(
    path.dirname(sourcePath),
    `${path.basename(sourcePath, path.extname(sourcePath))}-r${finalRotation}-${randomUUID()}${sourceExt}`,
  );
  await rotateFileToPath(sourcePath, outputPath, finalRotation);
  return { filePath: outputPath, transformed: true };
}
