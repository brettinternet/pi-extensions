import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  droppedFilePaths,
  loadDroppedImages,
} from "../extensions/image-attachments.ts";

test("parses quoted and escaped dropped image paths", () => {
  assert.deepEqual(
    droppedFilePaths(
      "\x1b[200~'screenshots/one image.png' screenshots/two\\ image.jpg\x1b[201~",
      "/project",
    ),
    [
      "/project/screenshots/one image.png",
      "/project/screenshots/two image.jpg",
    ],
  );
});

test("ignores ordinary keyboard input", () => {
  assert.deepEqual(droppedFilePaths("/tmp/image.png", "/project"), []);
});

test("rejects an image that cannot be decoded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-live-image-test-"));
  const path = join(directory, "broken.png");
  const validImage = await readFile("docs/screenshot.png");
  await writeFile(path, validImage.subarray(0, 64));

  await assert.rejects(
    loadDroppedImages(`\x1b[200~${path}\x1b[201~`, process.cwd()),
    /broken\.png could not be processed/,
  );
});

test("loads a dropped image for Pi", async () => {
  const [attachment] = await loadDroppedImages(
    "\x1b[200~docs/screenshot.png\x1b[201~",
    process.cwd(),
  );

  assert.equal(attachment?.name, "screenshot.png");
  assert.equal(attachment?.content.type, "image");
  assert.match(attachment?.content.mimeType ?? "", /^image\//);
  assert.ok((attachment?.content.data.length ?? 0) > 0);
});
