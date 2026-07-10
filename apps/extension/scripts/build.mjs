import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "src");
const output = join(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const entry of await readdir(source, { withFileTypes: true })) {
  await cp(join(source, entry.name), join(output, entry.name), { recursive: true });
}

console.log(`Built extension into ${output}`);
