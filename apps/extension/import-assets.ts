import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** Package-local format assets and licenses, also used by the offline MV3 reader. */
export function importAssets(): Plugin {
  const root = new URL("./node_modules/pdfjs-dist/", import.meta.url);
  const files = new Map<string, URL>();
  for (const dir of ["cmaps", "standard_fonts", "wasm"]) {
    for (const name of readdirSync(new URL(dir + "/", root))) {
      // No PDF scripting runtime; the reader never executes document actions.
      if (name.startsWith("quickjs")) continue;
      files.set(
        `import-assets/pdf/${dir}/${name}`,
        new URL(`${dir}/${name}`, root),
      );
    }
  }
  files.set("import-assets/licenses/pdfjs.txt", new URL("LICENSE", root));
  files.set(
    "import-assets/licenses/zip-js.txt",
    new URL("./node_modules/@zip.js/zip.js/LICENSE", import.meta.url),
  );
  files.set(
    "import-assets/licenses/node-unrar-js.txt",
    new URL("./node_modules/node-unrar-js/LICENSE.md", import.meta.url),
  );
  for (const [name, file] of Object.entries({
    "pdf-lib": "pdf-lib/LICENSE.md",
    "pdf-lib-standard-fonts": "@pdf-lib/standard-fonts/LICENSE.md",
    "pdf-lib-upng": "@pdf-lib/upng/LICENSE",
    "pdf-lib-pako": "pako/LICENSE",
    "pdf-lib-zlib": "pako/lib/zlib/README",
    "pdf-lib-tslib": "tslib/LICENSE.txt",
  })) {
    files.set(
      `import-assets/licenses/${name}.txt`,
      new URL("./node_modules/" + file, import.meta.url),
    );
  }
  // EPUB.js imports these packages even though archive/network access uses our local bridge.
  // JSZip and localforage browser distributions also embed their Promise/timing helpers.
  for (const [name, file] of Object.entries({
    "epub-js": "epubjs/license",
    "epub-xmldom": "@xmldom/xmldom/LICENSE",
    "epub-event-emitter": "event-emitter/LICENSE",
    "epub-d": "d/LICENSE",
    "epub-es5-ext": "es5-ext/LICENSE",
    "epub-type": "type/LICENSE",
    "epub-jszip": "jszip/LICENSE.markdown",
    "epub-localforage": "localforage/LICENSE",
    "epub-lodash": "lodash/LICENSE",
    "epub-lie": "lie/license.md",
    "epub-localforage-lie": "localforage/node_modules/lie/license.md",
    "epub-immediate": "immediate/LICENSE.txt",
    "epub-setimmediate": "setimmediate/LICENSE.txt",
  })) {
    files.set(
      `import-assets/licenses/${name}.txt`,
      new URL("./node_modules/" + file, import.meta.url),
    );
  }
  // These published packages declare MIT only in package.json. Their additional
  // attributions and the upstream Node path license are in public/import-assets/licenses.
  for (const name of ["marks-pane", "path-webpack"]) {
    files.set(
      `import-assets/licenses/epub-${name}-package.json`,
      new URL(`./node_modules/${name}/package.json`, import.meta.url),
    );
  }
  return {
    name: "local-comic-import-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = files.get(
          (req.url ?? "").split("?")[0].replace(/^\//, ""),
        );
        if (!file) return next();
        res.setHeader(
          "Content-Type",
          file.pathname.endsWith(".wasm")
            ? "application/wasm"
            : file.pathname.endsWith(".js")
              ? "text/javascript"
              : "application/octet-stream",
        );
        res.end(readFileSync(fileURLToPath(file)));
      });
    },
    generateBundle() {
      for (const [fileName, url] of files)
        this.emitFile({ type: "asset", fileName, source: readFileSync(url) });
    },
  };
}
