import {
  resolveImageObject,
  type PdfImageObject,
  type PdfPageProxy,
} from './color-detection';

type Store = NonNullable<PdfPageProxy['objs']>;

/** Mimics pdf.js PDFObjects: get() throws until the object is resolved. */
function createStore(objects: Record<string, PdfImageObject>): Store & {
  lookups: string[];
} {
  const lookups: string[] = [];
  return {
    lookups,
    get(name: string, callback?: (obj: unknown) => void): unknown {
      lookups.push(name);
      const found = objects[name];
      if (callback) {
        // An unknown id never calls back, exactly like pdf.js.
        if (found) callback(found);
        return null;
      }
      if (!found) {
        throw new Error(`Requesting object that isn't resolved yet ${name}.`);
      }
      return found;
    },
  };
}

function createPage(
  objs: Store,
  commonObjs?: Store,
): PdfPageProxy {
  return {
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    cleanup: () => {},
    objs,
    ...(commonObjs ? { commonObjs } : {}),
  };
}

const logo: PdfImageObject = { width: 2, height: 2 };

describe('resolveImageObject', () => {
  it('reads page-level images from the page store', async () => {
    const objs = createStore({ img_p0_1: logo });
    const commonObjs = createStore({});

    await expect(
      resolveImageObject(createPage(objs, commonObjs), 'img_p0_1'),
    ).resolves.toBe(logo);
    expect(commonObjs.lookups).toEqual([]);
  });

  it('reads document-level (shared) images from the common store', async () => {
    // pdf.js stores images reused across pages under a "g_" id in commonObjs.
    const objs = createStore({});
    const commonObjs = createStore({ g_d0_img_p0_1: logo });

    const started = Date.now();
    const result = await resolveImageObject(
      createPage(objs, commonObjs),
      'g_d0_img_p0_1',
    );

    expect(result).toBe(logo);
    expect(objs.lookups).toEqual([]);
    // No 200 ms wait on a store that can never answer.
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('returns null for a shared image when the page has no common store', async () => {
    const objs = createStore({});

    await expect(
      resolveImageObject(createPage(objs), 'g_d0_img_p0_1'),
    ).resolves.toBeNull();
    expect(objs.lookups).toEqual([]);
  });
});
