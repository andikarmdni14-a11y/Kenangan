// Optional: node build.mjs. The generated HTML files are already ready to serve.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const layout = await fs.readFile(path.join(root, "src/layout.html"), "utf8");
const pages = {
  utama: "Utama",
  kenangan: "Rak Kenangan",
  jurnal: "Jurnal Harian",
  impian: "Impian Kita",
  surat: "Surat Cinta",
};
for (const [page, title] of Object.entries(pages)) {
  const view = await fs.readFile(
    path.join(root, `src/pages/${page}.html`),
    "utf8",
  );
  const directory = page === "utama" ? root : path.join(root, page);
  await fs.mkdir(directory, { recursive: true });
  const html = layout
    .replaceAll("{{page}}", page)
    .replaceAll("{{title}}", title)
    .replaceAll("{{base}}", page === "utama" ? "./" : "../")
    .replace("{{view}}", view);
  if (/\{\{\w+\}\}/.test(html)) throw Error(`Placeholder tersisa: ${page}`);
  await fs.writeFile(path.join(directory, "index.html"), html);
}
console.log("Lima halaman siap: /, /kenangan/, /jurnal/, /impian/, /surat/.");
