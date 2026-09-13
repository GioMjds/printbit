import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { calculatePrintLayout } from '../../src/shared/print-configuration';

// Exercise the actual preview methods without starting the kiosk or its hardware APIs.
const source = fs.readFileSync(path.resolve(__dirname, '../../src/public/config/app.ts'), 'utf8');
const parsed = ts.createSourceFile('app.ts', source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(
  (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'PrintPreview',
)!;
const compiled = ts.transpileModule(declaration.getText(parsed), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const Preview = new Function('calculatePrintLayout', `${compiled}; return PrintPreview;`)(calculatePrintLayout);

describe('image preview layout', () => {
  it('keeps image-to-paper size constant when the preview zoom changes', () => {
    const preview = Object.create(Preview.prototype);
    preview.viewport = { clientWidth: 700, clientHeight: 900 };
    preview.sheet = {
      style: { width: '', height: '' },
      getBoundingClientRect: () => ({ width: parseFloat(preview.sheet.style.width) }),
    };
    preview.img = { style: {} };
    preview.naturalW = 612;
    preview.naturalH = 792;
    preview.zoomScale = 1;
    preview.latestImageInfo = { naturalWidth: 612, naturalHeight: 792 };
    preview.printConfig = { paperSize: 'Letter', orientation: 'portrait', scaling: 'fit', rotationDeg: 0 };
    preview.resizeSheet();
    preview.layoutImage();
    const initialWidth = parseFloat(preview.img.style.width);
    preview.zoomScale = 1.5;
    preview.resizeSheet();
    expect(parseFloat(preview.img.style.width)).toBeCloseTo(initialWidth * 1.5);
  });
});
