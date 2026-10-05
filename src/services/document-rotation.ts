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
): Promise<boolean> {
  const bytes = await fs.promises.readFile(sourcePath);
  const pdf = await PDFDocument.load(bytes);
  let modified = false;

  for (const page of pdf.getPages()) {
    const current = page.getRotation().angle;
    let extraRotation = 0;

    if (targetOrientation) {
      const w = page.getWidth();
      const h = page.getHeight();
      const isLandscape =
        current === 90 || current === 270 ? h > w : w > h;
      const wantsLandscape = targetOrientation === 'landscape';
      if (isLandscape !== wantsLandscape) {
        extraRotation = 90;
      }
    }

    const next = ((current + rotationDeg + extraRotation) % 360 + 360) % 360;
    if (next !== current) {
      page.setRotation(degrees(next));
      modified = true;
    }
  }

  if (!modified) {
    return false;
  }

  const rotatedBytes = await pdf.save();
  await fs.promises.writeFile(outputPath, rotatedBytes);
  return true;
}

async function rotateImageFile(
  sourcePath: string,
  outputPath: string,
  rotationDeg: RotationDeg,
  targetOrientation?: 'portrait' | 'landscape',
): Promise<boolean> {
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
  if (finalRotation === 0) {
    return false;
  }

  await image.rotate(finalRotation).toFile(outputPath);
  return true;
}

async function rotateFileToPath(
  sourcePath: string,
  outputPath: string,
  rotationDeg: RotationDeg,
  targetOrientation?: 'portrait' | 'landscape',
): Promise<boolean> {
  const extension = path.extname(sourcePath).toLowerCase();
  if (extension === '.pdf') {
    return rotatePdfFile(sourcePath, outputPath, rotationDeg, targetOrientation);
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return rotateImageFile(sourcePath, outputPath, rotationDeg, targetOrientation);
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
  const sourceExt = normalizeFileExtension(path.extname(sourcePath).toLowerCase());
  if (sourceExt !== '.pdf' && !IMAGE_EXTENSIONS.has(sourceExt)) {
    throw new Error(
      `Rotation is not supported for ${sourceExt || 'this'} scan format.`,
    );
  }

  const outputPath = path.join(
    path.dirname(sourcePath),
    `${path.basename(sourcePath, path.extname(sourcePath))}-r${rotationDeg}-${randomUUID()}${sourceExt}`,
  );
  const transformed = await rotateFileToPath(
    sourcePath,
    outputPath,
    rotationDeg,
    orientation,
  );
  if (!transformed) {
    return { filePath: sourcePath, transformed: false };
  }
  return { filePath: outputPath, transformed: true };
}
